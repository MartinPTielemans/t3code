/**
 * ProviderSkillTransfer — copy one of the user's own skills between
 * environments. Fleet exports the skill from a machine that has it and
 * imports it on one that lacks it; the client carries the bytes.
 *
 * Both ends resolve the directory themselves from the instance's
 * `personalSkillsDirectory`: export only reads a skill the provider reports
 * from that directory, and import only writes one new directory inside it.
 * An existing skill is never overwritten.
 *
 * @module provider/ProviderSkillTransfer
 */
import {
  PROVIDER_SKILL_TRANSFER_MAX_BYTES,
  PROVIDER_SKILL_TRANSFER_MAX_FILES,
  type ProviderInstanceId,
  type ProviderSkillBundle,
  type ProviderSkillExportInput,
  type ProviderSkillFile,
  type ProviderSkillImportInput,
  type ProviderSkillImportResult,
  ProviderSkillTransferError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";

const SKILL_ENTRY_FILE = "SKILL.md";

export class ProviderSkillTransfer extends Context.Service<
  ProviderSkillTransfer,
  {
    readonly exportSkill: (
      input: ProviderSkillExportInput,
    ) => Effect.Effect<ProviderSkillBundle, ProviderSkillTransferError>;
    readonly importSkill: (
      input: ProviderSkillImportInput,
    ) => Effect.Effect<ProviderSkillImportResult, ProviderSkillTransferError>;
  }
>()("t3/provider/ProviderSkillTransfer") {}

const fail = (instanceId: ProviderInstanceId, name: string, reason: string) =>
  new ProviderSkillTransferError({ instanceId, name, reason });

/** A bundle path that stays inside the skill directory once joined. */
function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.includes("\0"))
    return false;
  const segments = relativePath.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Read a skill directory into a bundle. Regular files only (a symlink is read
 * through, so a skill linked in from a dotfiles checkout copies its contents);
 * hidden entries such as `.git` are left behind.
 */
export const readSkillDirectory = Effect.fn("ProviderSkillTransfer.readSkillDirectory")(function* (
  instanceId: ProviderInstanceId,
  skillDirectory: string,
  name: ProviderSkillBundle["name"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const unreadable = (reason: string) => fail(instanceId, name, reason);
  const entries = yield* fs
    .readDirectory(skillDirectory, { recursive: true })
    .pipe(Effect.mapError(() => unreadable("its directory could not be read")));
  const files: ProviderSkillFile[] = [];
  let bytes = 0;
  for (const entry of [...entries].sort()) {
    const relativePath = entry.split(path.sep).join("/");
    if (relativePath.split("/").some((segment) => segment.startsWith("."))) continue;
    const absolute = path.join(skillDirectory, entry);
    const info = yield* fs.stat(absolute).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") continue;
    if (files.length >= PROVIDER_SKILL_TRANSFER_MAX_FILES)
      return yield* unreadable(`it has more than ${PROVIDER_SKILL_TRANSFER_MAX_FILES} files`);
    const contents = yield* fs
      .readFile(absolute)
      .pipe(Effect.mapError(() => unreadable(`${relativePath} could not be read`)));
    bytes += contents.byteLength;
    if (bytes > PROVIDER_SKILL_TRANSFER_MAX_BYTES)
      return yield* unreadable(
        `it is larger than ${PROVIDER_SKILL_TRANSFER_MAX_BYTES / 1024 / 1024} MiB`,
      );
    files.push({
      path: relativePath,
      contents: Buffer.from(contents).toString("base64"),
      ...((info.value.mode & 0o111) !== 0 ? { executable: true } : {}),
    });
  }
  if (!files.some((file) => file.path === SKILL_ENTRY_FILE))
    return yield* unreadable(`it has no ${SKILL_ENTRY_FILE}`);
  return { name, files } satisfies ProviderSkillBundle;
});

/**
 * Write a bundle as `<root>/<name>`, staged beside the root (where no CLI
 * scans for skills) and moved into place, so the CLI never sees half a skill.
 */
export const writeSkillDirectory = Effect.fn("ProviderSkillTransfer.writeSkillDirectory")(
  function* (instanceId: ProviderInstanceId, root: string, skill: ProviderSkillBundle) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const refuse = (reason: string) => fail(instanceId, skill.name, reason);
    if (!skill.files.some((file) => file.path === SKILL_ENTRY_FILE))
      return yield* refuse(`it has no ${SKILL_ENTRY_FILE}`);
    const unsafe = skill.files.find((file) => !isSafeRelativePath(file.path));
    if (unsafe) return yield* refuse(`${unsafe.path} is not a path inside the skill`);
    const decoded = skill.files.map((file) => ({
      ...file,
      bytes: Uint8Array.from(Buffer.from(file.contents, "base64")),
    }));
    if (
      decoded.reduce((sum, file) => sum + file.bytes.byteLength, 0) >
      PROVIDER_SKILL_TRANSFER_MAX_BYTES
    )
      return yield* refuse(
        `it is larger than ${PROVIDER_SKILL_TRANSFER_MAX_BYTES / 1024 / 1024} MiB`,
      );

    const destination = path.join(root, skill.name);
    const exists = yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => true));
    if (exists) return yield* refuse("a skill with that name is already here");

    const writeFailed = () => refuse("it could not be written here");
    yield* fs.makeDirectory(root, { recursive: true }).pipe(Effect.mapError(writeFailed));
    const staging = yield* fs
      .makeTempDirectory({ directory: path.dirname(root), prefix: `.skill-${skill.name}-` })
      .pipe(Effect.mapError(writeFailed));
    yield* Effect.gen(function* () {
      for (const file of decoded) {
        const target = path.join(staging, ...file.path.split("/"));
        yield* fs.makeDirectory(path.dirname(target), { recursive: true });
        yield* fs.writeFile(target, file.bytes, { mode: file.executable ? 0o755 : 0o644 });
      }
      yield* fs.rename(staging, destination);
    }).pipe(
      Effect.mapError(writeFailed),
      Effect.onError(() => fs.remove(staging, { recursive: true }).pipe(Effect.ignore)),
    );
    return { name: skill.name, path: path.join(destination, SKILL_ENTRY_FILE) };
  },
);

export const make = Effect.fn("ProviderSkillTransfer.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;

  const personalRoot = Effect.fn("ProviderSkillTransfer.personalRoot")(function* (
    instanceId: ProviderInstanceId,
    name: string,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance === undefined)
      return yield* fail(instanceId, name, "that provider is not set up here");
    if (instance.personalSkillsDirectory === undefined)
      return yield* fail(instanceId, name, "this provider's skills cannot be copied");
    return path.resolve(instance.personalSkillsDirectory);
  });

  const exportSkill = Effect.fn("ProviderSkillTransfer.exportSkill")(function* (
    input: ProviderSkillExportInput,
  ) {
    const root = yield* personalRoot(input.instanceId, input.name);
    const snapshot = (yield* providers.getProviders).find(
      (provider) => provider.instanceId === input.instanceId,
    );
    // Only a skill the provider itself loads from the personal root, by the
    // name it reports: the request never names a path.
    const skill = snapshot?.skills.find(
      (candidate) =>
        candidate.name === input.name &&
        path.resolve(path.dirname(path.dirname(candidate.path))) === root,
    );
    if (skill === undefined)
      return yield* fail(input.instanceId, input.name, "no personal skill by that name here");
    return yield* readSkillDirectory(input.instanceId, path.dirname(skill.path), input.name).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  });

  const importSkill = Effect.fn("ProviderSkillTransfer.importSkill")(function* (
    input: ProviderSkillImportInput,
  ) {
    const root = yield* personalRoot(input.instanceId, input.skill.name);
    const result = yield* writeSkillDirectory(input.instanceId, root, input.skill).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    // The snapshot lists skills; refresh it so every client sees the new one.
    yield* providers.refreshInstance(input.instanceId);
    return result;
  });

  return ProviderSkillTransfer.of({ exportSkill, importSkill });
});

export const layer = Layer.effect(ProviderSkillTransfer, make());
