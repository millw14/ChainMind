// Tests for THE REPOSITORY READER — services/research/lib/repo.js.
//
// THE PROPERTY THAT MATTERS HERE IS COMPLETENESS, not matching. The reference investigation
// this feature reproduces established that a repository contained exactly ONE Ethereum
// address, a zero placeholder — and that finding is a NEGATIVE CLAIM about every file that
// was not read. A grep over 40 of a repository's 900 files that reports "one address" is
// not a weaker version of the finding; it is a FALSE one.
//
// So `complete` is the field under test: what makes it true, everything that makes it
// false, and the fact that a false one states in words that no absence may be asserted.
// Also under test: the path and reference parsing, because owner and repository names go
// into a URL path and a segment containing `..` is how a path becomes a different endpoint.
//
// Fully offline: the GitHub transport is injected.
// Run with: npm test (from the repository root)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepoReader, isSafePath, isTextPath, parseRepoRef } from "../lib/repo.js";

/* ------------------------------- parsing, purely ------------------------------- */

test("every shape a page or a person actually writes a repository as", () => {
  assert.deepEqual(pick(parseRepoRef("acme/app")), { owner: "acme", repo: "app", ref: null, path: null });
  assert.deepEqual(pick(parseRepoRef("https://github.com/acme/app")), { owner: "acme", repo: "app", ref: null, path: null });
  assert.deepEqual(pick(parseRepoRef("github.com/acme/app.git")), { owner: "acme", repo: "app", ref: null, path: null });
  assert.deepEqual(pick(parseRepoRef("https://www.github.com/acme")), { owner: "acme", repo: null, ref: null, path: null });
  assert.deepEqual(pick(parseRepoRef("https://github.com/acme/app/blob/main/src/chain.js")), { owner: "acme", repo: "app", ref: "main", path: "src/chain.js" });
});

test("a reference that would escape the repository path is refused, never cleaned", () => {
  for (const bad of ["", "   ", "not a repo", "https://gitlab.com/acme/app", "../../etc", "acme/../../x", "https://github.com/acme/app/blob/main/../../../etc/passwd"]) {
    const parsed = parseRepoRef(bad);
    if (parsed) assert.equal(parsed.path, null, `${bad} produced a traversing path`);
    else assert.equal(parsed, null);
  }
});

test("isSafePath refuses traversal, absolutes and backslashes rather than normalising them", () => {
  assert.equal(isSafePath("src/chain.js"), true);
  assert.equal(isSafePath("a/b/c-d_e.2.json"), true);
  for (const bad of ["/etc/passwd", "src/../../../etc", "..", "./x", "src\\win.js", "", "a".repeat(500), "src/x;y"]) {
    assert.equal(isSafePath(bad), false, `${bad} was allowed`);
  }
});

test("isTextPath is an allow-list: skipping a PNG costs nothing, decoding one produces mojibake", () => {
  for (const p of ["src/chain.js", "README.md", "Dockerfile", "LICENSE", "a/b/config.yaml", "contracts/Token.sol", ".gitignore"]) {
    assert.equal(isTextPath(p), true, `${p} was treated as binary`);
  }
  for (const p of ["logo.png", "font.woff2", "build.wasm", "x.bin", "noextension"]) {
    assert.equal(isTextPath(p), false, `${p} was treated as text`);
  }
});

/* ------------------------------ completeness ------------------------------ */

test("a search that read every text file is COMPLETE, and licenses an absence", async () => {
  const zero = "0x0000000000000000000000000000000000000000";
  const reader = reading({ files: { "src/chain.js": `const TREASURY = "${zero}";`, "README.md": "# app", "logo.png": " binary" } });

  const got = await reader.search("acme", "app", "0x", { maxFiles: 50 });
  assert.equal(got.ok, true);
  assert.equal(got.complete, true, "a search over every text file must be complete");
  assert.equal(got.matchCount, 1);
  assert.equal(got.filesRead, 2, "the PNG is skipped as a type, which does not make the search incomplete");
  assert.match(got.reading, /Because the search was COMPLETE, an absence found here is a real absence/);
  assert.match(got.reading, /says nothing about other branches/);
});

test("a search stopped by its own file cap is NOT complete and forbids stating an absence", async () => {
  const files = {};
  for (let i = 0; i < 10; i += 1) files[`src/f${i}.js`] = `// file ${i}`;

  const got = await reading({ files }).search("acme", "app", "exchangeContract", { maxFiles: 3 });
  assert.equal(got.complete, false);
  assert.equal(got.filesRead, 3);
  assert.ok(got.filesUnread > 0);
  assert.match(got.reading, /NO ABSENCE MAY BE ASSERTED FROM THIS RESULT in any wording/);
  assert.match(got.reading, /an unread file is not a file without matches/);
});

test("a truncated tree makes every search over it incomplete, whatever it read", async () => {
  const reader = reading({ files: { "a.js": "x" }, treeTruncated: true });
  const tree = await reader.tree("acme", "app");
  assert.equal(tree.truncated, true);
  assert.match(tree.note, /may rest on it/);

  const got = await reader.search("acme", "app", "anything");
  assert.equal(got.complete, false);
  assert.equal(got.treeTruncated, true);
});

test("a file that could not be read makes the search incomplete rather than silently empty", async () => {
  const got = await reading({ files: { "a.js": "x", "b.js": "y" }, failPaths: ["b.js"] }).search("acme", "app", "z");
  assert.equal(got.complete, false, "an unreadable file is unread, and an unread file is not a file without matches");
  assert.ok(got.skipped.some((row) => row.path === "b.js"));
});

/* ------------------------------ counts and floors ------------------------------ */

test("a commit count that hit the page cap is a FLOOR and says so in the same breath", async () => {
  const reader = createRepoReader({
    limits: { INTERVAL_MS: 0, COMMIT_PAGES: 2, COMMITS_PER_PAGE: 100 },
    fetcher: async (url) => {
      const pageNo = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? 1);
      return json(commitPage(100, pageNo * 100));
    },
  });
  const got = await reader.commits("acme", "app");
  assert.equal(got.countIsFloor, true);
  assert.equal(got.count, 200);
  assert.match(got.note, /AT LEAST 200 commits/);
  assert.match(got.note, /Never quote it as/);
});

test("a commit walk that ran out of commits is EXACT, and warns that dates are claims", async () => {
  const reader = createRepoReader({ limits: { INTERVAL_MS: 0 }, fetcher: async () => json(commitPage(2, 0)) });
  const got = await reader.commits("acme", "app");
  assert.equal(got.countIsFloor, false);
  assert.equal(got.count, 2);
  assert.equal(got.spanDays, 1);
  assert.equal(got.distinctAuthors, 1);
  assert.match(got.note, /Commit dates are attacker-controllable/);
});

/* --------------------------------- failure modes --------------------------------- */

test("rate limiting and 404 are named as lookup failures, never as facts about a repository", async () => {
  const limited = createRepoReader({
    limits: { INTERVAL_MS: 0 },
    fetcher: async () => ({ ok: false, status: 403, headers: { get: (h) => (h === "x-ratelimit-remaining" ? "0" : null) }, text: async () => "" }),
  });
  const rate = await limited.repoMeta("acme", "app");
  assert.equal(rate.ok, false);
  assert.match(rate.refusal, /says nothing whatever about the repository/);

  const missing = createRepoReader({ limits: { INTERVAL_MS: 0 }, fetcher: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => "" }) });
  const gone = await missing.repoMeta("acme", "app");
  assert.equal(gone.ok, false);
  assert.match(gone.refusal, /it may not exist, or it may be private/);
});

test("the per-investigation request ceiling refuses further reads rather than looping", async () => {
  const reader = createRepoReader({ limits: { INTERVAL_MS: 0, API_REQUESTS: 2 }, fetcher: async () => json({}) });
  assert.equal((await reader.repoMeta("a", "b")).ok, true);
  assert.equal((await reader.repoMeta("a", "b")).ok, true);
  const third = await reader.repoMeta("a", "b");
  assert.equal(third.ok, false);
  assert.match(third.refusal, /UNREAD, not empty/);
});

test("a file path that is not one is refused before any request is made", async () => {
  let called = 0;
  const reader = createRepoReader({
    limits: { INTERVAL_MS: 0 },
    fetcher: async () => {
      called += 1;
      return json({});
    },
  });
  const got = await reader.file("acme", "app", "../../../etc/passwd");
  assert.equal(got.ok, false);
  assert.equal(called, 0, "a traversing path must not reach the network");
});

/* --------------------------------- the fake GitHub --------------------------------- */

function json(value, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(value) };
}

function text(body, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => body };
}

/**
 * A fake GitHub. `files` is path -> contents; the tree and the raw endpoints are served
 * from it, so a test can make a repository truncated or partly unreadable and watch what
 * `complete` does about it.
 */
function fakeGitHub({ files = {}, treeTruncated = false, failPaths = [] } = {}) {
  return async (url) => {
    if (url.includes("/git/trees/")) {
      return json({ truncated: treeTruncated, tree: Object.entries(files).map(([path, body]) => ({ path, type: "blob", size: body.length })) });
    }
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const path = decodeURIComponent(url.split("/").slice(6).join("/"));
      if (failPaths.includes(path)) return text("nope", 500);
      return files[path] == null ? text("", 404) : text(files[path]);
    }
    if (url.includes("/commits")) return json([]);
    return json({ full_name: "acme/app", default_branch: "main", size: 12, created_at: "2026-01-01T00:00:00Z" });
  };
}

/** A page of commits, one per day, all by one author. */
function commitPage(n, from) {
  return Array.from({ length: n }, (_, i) => ({
    sha: `${from + i}`.padStart(40, "0"),
    commit: { author: { date: new Date(1_700_000_000_000 + (from + i) * 86_400_000).toISOString(), name: "dev" }, message: `commit ${from + i}` },
    author: { login: "dev" },
  }));
}

function pick(r) {
  return r ? { owner: r.owner, repo: r.repo, ref: r.ref, path: r.path } : r;
}

/** A reader wired to a fake GitHub holding these files. */
function reading(opts) {
  return createRepoReader({ limits: { INTERVAL_MS: 0 }, fetcher: fakeGitHub(opts) });
}
