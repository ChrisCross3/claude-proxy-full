import test from "node:test";
import assert from "node:assert/strict";
import {
  createCredentialsResolver,
  CredentialsExpiredError,
  CredentialsMalformedError,
  CredentialsNotFoundError,
} from "../auth/credentials-resolver.js";

interface FakeFs {
  files: Map<string, { content: string; mtimeMs: number }>;
}

function makeFs(initial: Record<string, { content: string; mtimeMs: number }> = {}): FakeFs {
  return {
    files: new Map(Object.entries(initial)),
  };
}

function stubResolver(fs: FakeFs, opts: { now?: () => number; path?: string } = {}) {
  const path = opts.path ?? "/fake/.claude/.credentials.json";
  return createCredentialsResolver({
    credentialsPath: path,
    now: opts.now,
    readFile: async (p) => {
      const entry = fs.files.get(p);
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return entry.content;
    },
    stat: async (p) => {
      const entry = fs.files.get(p);
      if (!entry) throw new Error(`ENOENT: ${p}`);
      return { mtimeMs: entry.mtimeMs };
    },
  });
}

test("credentials-resolver: happy-path returns accessToken", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-TEST",
          refreshToken: "sk-ant-ort01-REFRESH",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      mtimeMs: 1000,
    },
  });
  const resolver = stubResolver(fs);
  const token = await resolver.resolve();
  assert.equal(token, "sk-ant-oat01-TEST");
});

test("credentials-resolver: caches on second call without re-reading", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-FIRST",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      mtimeMs: 1000,
    },
  });
  let readCount = 0;
  const resolver = createCredentialsResolver({
    credentialsPath: path,
    readFile: async (p) => {
      readCount++;
      return fs.files.get(p)!.content;
    },
    stat: async (p) => ({ mtimeMs: fs.files.get(p)!.mtimeMs }),
  });

  await resolver.resolve();
  await resolver.resolve();
  await resolver.resolve();
  assert.equal(readCount, 1, "file should only be read once when cached");
});

test("credentials-resolver: re-reads when mtime changes (token rotation)", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-OLD",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
      mtimeMs: 1000,
    },
  });
  const resolver = stubResolver(fs);
  const first = await resolver.resolve();
  assert.equal(first, "sk-ant-oat01-OLD");

  // Simulate rotation: new content, new mtime.
  fs.files.set(path, {
    content: JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat01-NEW",
        expiresAt: Date.now() + 3_600_000,
      },
    }),
    mtimeMs: 2000,
  });

  const second = await resolver.resolve();
  assert.equal(second, "sk-ant-oat01-NEW");
});

test("credentials-resolver: throws CredentialsNotFoundError when file missing", async () => {
  const fs = makeFs();
  const resolver = stubResolver(fs);
  await assert.rejects(() => resolver.resolve(), CredentialsNotFoundError);
});

test("credentials-resolver: throws CredentialsMalformedError on invalid JSON", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: { content: "not json {{{", mtimeMs: 1000 },
  });
  const resolver = stubResolver(fs);
  await assert.rejects(() => resolver.resolve(), CredentialsMalformedError);
});

test("credentials-resolver: throws on missing claudeAiOauth field", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: { content: JSON.stringify({ other: "field" }), mtimeMs: 1000 },
  });
  const resolver = stubResolver(fs);
  await assert.rejects(() => resolver.resolve(), CredentialsMalformedError);
});

test("credentials-resolver: throws on empty accessToken", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({ claudeAiOauth: { accessToken: "" } }),
      mtimeMs: 1000,
    },
  });
  const resolver = stubResolver(fs);
  await assert.rejects(() => resolver.resolve(), CredentialsMalformedError);
});

test("credentials-resolver: throws CredentialsExpiredError when expiresAt < now", async () => {
  const path = "/fake/.claude/.credentials.json";
  const nowMs = 5_000_000;
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-EXPIRED",
          expiresAt: nowMs - 1000, // 1 second in the past
        },
      }),
      mtimeMs: 1000,
    },
  });
  const resolver = stubResolver(fs, { now: () => nowMs });
  await assert.rejects(() => resolver.resolve(), CredentialsExpiredError);
});

test("credentials-resolver: accepts token without expiresAt field (legacy format)", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-LEGACY" } }),
      mtimeMs: 1000,
    },
  });
  const resolver = stubResolver(fs);
  const token = await resolver.resolve();
  assert.equal(token, "sk-ant-oat01-LEGACY");
});

test("credentials-resolver: clearCache forces re-read", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-X", expiresAt: Date.now() + 3_600_000 },
      }),
      mtimeMs: 1000,
    },
  });
  let readCount = 0;
  const resolver = createCredentialsResolver({
    credentialsPath: path,
    readFile: async (p) => {
      readCount++;
      return fs.files.get(p)!.content;
    },
    stat: async (p) => ({ mtimeMs: fs.files.get(p)!.mtimeMs }),
  });

  await resolver.resolve();
  resolver.clearCache();
  await resolver.resolve();
  assert.equal(readCount, 2);
});

test("credentials-resolver: hasChangedSince detects rotation", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-X", expiresAt: Date.now() + 3_600_000 },
      }),
      mtimeMs: 5000,
    },
  });
  const resolver = stubResolver(fs);
  assert.equal(await resolver.hasChangedSince(4000), true);
  assert.equal(await resolver.hasChangedSince(6000), false);
});

test("credentials-resolver: hasChangedSince returns true when file missing", async () => {
  const fs = makeFs();
  const resolver = stubResolver(fs);
  assert.equal(await resolver.hasChangedSince(1000), true);
});

test("credentials-resolver: getCachedExpiresAtMs returns null before first resolve", async () => {
  const fs = makeFs();
  const resolver = stubResolver(fs);
  assert.equal(resolver.getCachedExpiresAtMs(), null);
});

test("credentials-resolver: getCachedExpiresAtMs returns expiresAt after resolve", async () => {
  const path = "/fake/.claude/.credentials.json";
  const expiresAt = Date.now() + 3_600_000;
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-X", expiresAt },
      }),
      mtimeMs: 1000,
    },
  });
  const resolver = stubResolver(fs);
  await resolver.resolve();
  assert.equal(resolver.getCachedExpiresAtMs(), expiresAt);
});

test("credentials-resolver: getCachedExpiresAtMs returns null for legacy-format token (no expiresAt)", async () => {
  const path = "/fake/.claude/.credentials.json";
  const fs = makeFs({
    [path]: {
      content: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-LEGACY" } }),
      mtimeMs: 1000,
    },
  });
  const resolver = stubResolver(fs);
  await resolver.resolve();
  assert.equal(resolver.getCachedExpiresAtMs(), null);
});
