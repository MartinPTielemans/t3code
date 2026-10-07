import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderSkillBundle } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readSkillDirectory, writeSkillDirectory } from "./ProviderSkillTransfer.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const name = "tdd" as ProviderSkillBundle["name"];
const base64 = (text: string) => Buffer.from(text).toString("base64");

const makeSkill = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(root, "tdd");
  yield* fs.makeDirectory(path.join(dir, "scripts"), { recursive: true });
  yield* fs.makeDirectory(path.join(dir, ".git"), { recursive: true });
  yield* fs.writeFileString(path.join(dir, "SKILL.md"), "---\nname: tdd\n---\nRed, green.\n");
  yield* fs.writeFileString(path.join(dir, "scripts", "run.sh"), "#!/bin/sh\necho ok\n");
  yield* fs.chmod(path.join(dir, "scripts", "run.sh"), 0o755);
  yield* fs.writeFileString(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
});

it.layer(NodeServices.layer)("ProviderSkillTransfer", (it) => {
  it.effect("copies a skill directory between roots, keeping the executable bit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-transfer-" });
      const source = yield* makeSkill(path.join(temp, "source", "skills"));

      const bundle = yield* readSkillDirectory(instanceId, source, name);
      assert.deepStrictEqual(
        bundle.files.map((file) => [file.path, file.executable ?? false]),
        [
          ["SKILL.md", false],
          ["scripts/run.sh", true],
        ],
      );

      const targetRoot = path.join(temp, "target", "skills");
      const result = yield* writeSkillDirectory(instanceId, targetRoot, bundle);
      assert.strictEqual(result.path, path.join(targetRoot, "tdd", "SKILL.md"));
      assert.strictEqual(
        yield* fs.readFileString(path.join(targetRoot, "tdd", "scripts", "run.sh")),
        "#!/bin/sh\necho ok\n",
      );
      const info = yield* fs.stat(path.join(targetRoot, "tdd", "scripts", "run.sh"));
      assert.notStrictEqual(info.mode & 0o111, 0);
      // Nothing is left staged beside the root.
      assert.deepStrictEqual(yield* fs.readDirectory(path.join(temp, "target")), ["skills"]);
    }),
  );

  it.effect("never overwrites a skill that is already there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-transfer-" });
      const root = path.join(temp, "skills");
      yield* makeSkill(root);
      const error = yield* writeSkillDirectory(instanceId, root, {
        name,
        files: [{ path: "SKILL.md", contents: base64("replaced") }],
      }).pipe(Effect.flip);
      assert.include(error.reason, "already here");
      assert.include(yield* fs.readFileString(path.join(root, "tdd", "SKILL.md")), "Red, green.");
    }),
  );

  it.effect("refuses paths that leave the skill directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-transfer-" });
      for (const unsafe of ["../escape.md", "/etc/passwd", "a/../../b", "a\\b"]) {
        const error = yield* writeSkillDirectory(instanceId, path.join(temp, "skills"), {
          name,
          files: [
            { path: "SKILL.md", contents: base64("ok") },
            { path: unsafe, contents: base64("nope") },
          ],
        }).pipe(Effect.flip);
        assert.include(error.reason, "not a path inside the skill");
      }
      assert.isFalse(yield* fs.exists(path.join(temp, "skills", "tdd")));
    }),
  );

  it.effect("refuses a directory without SKILL.md", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skill-transfer-" });
      yield* fs.makeDirectory(path.join(temp, "notes"));
      yield* fs.writeFileString(path.join(temp, "notes", "README.md"), "hi");
      const error = yield* readSkillDirectory(instanceId, path.join(temp, "notes"), name).pipe(
        Effect.flip,
      );
      assert.include(error.reason, "no SKILL.md");
    }),
  );
});
