import test from "node:test";
import assert from "node:assert/strict";
import { compareGitState } from "../orchestrator/git-safety.js";

test("Git comparison accepts identical state", () => { const state = { branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" }; assert.equal(compareGitState(state, { ...state }).safe, true); });
test("Git comparison rejects changed status", () => { const before = { branch: "dev", head: "a", status: "", diffStat: "", stagedDiffStat: "" }; assert.deepEqual(compareGitState(before, { ...before, status: "?? file" }).changed, ["status"]); });
