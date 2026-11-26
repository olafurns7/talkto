import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { rpc, packet } from "./mcp-wire.mjs";
import { start } from "./platform-harness.mjs";
import { committedSnapshots, everyTool, outputSchemas } from "./mcp-output.mjs";

/*
  MCP hosts read each tool's outputSchema from tools/list when a session connects and check every
  structuredContent reply against that cached schema for the life of the session (November 16,
  2026: sessions connected before a deploy refused every reply). So each reply this release sends
  must match the schema of every release a session may have connected under: every snapshot in
  contracts/mcp-output/, plus this build's own tools/list. See docs/mcp-compatibility.md.
*/

/**
 * Validators configured as the MCP SDK's AjvJsonSchemaValidator. SDK 1.x uses the draft-07 engine
 * and SDK 2.x the 2020-12 engine for schemas without `$schema`; hosts are built on either.
 */
const engines = [Ajv, Ajv2020].map((Engine) => {
  const ajv = new Engine({
    strict: false,
    validateFormats: true,
    validateSchema: false,
    allErrors: true,
  });
  addFormats(ajv);
  return { name: Engine === Ajv ? "draft-07" : "2020-12", ajv };
});

const sha = "a".repeat(64);
const commit = "9f3c2ab4d1e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0";

/** Check replies against every contract; collect each failure the way a host would word it. */
const contracts = (current) => {
  const sources = [...committedSnapshots(), { name: "this build's tools/list", schemas: current }];
  const compiled = new Map();
  const failures = [];
  const validator = (source, engine, tool) => {
    const key = `${source.name}\u0000${engine.name}\u0000${tool}`;
    if (!compiled.has(key)) compiled.set(key, engine.ajv.compile(source.schemas[tool]));
    return compiled.get(key);
  };
  const check = (tool, step, reply) => {
    for (const source of sources) {
      // A tool a release did not list cannot be called by a session from that release.
      if (source.schemas[tool] === undefined) continue;
      for (const engine of engines) {
        const validate = validator(source, engine, tool);
        if (validate(reply)) continue;
        failures.push(
          `${source.name} (${engine.name}), ${tool}, ${step}: Structured content does not match the tool's output schema: ${engine.ajv.errorsText(validate.errors)}`,
        );
      }
    }
  };
  return { sources, failures, check };
};

/** One server and two agents over one MCP connection, every reply checked against every contract. */
const session = async (x, credential, accountId, check, version) => {
  // A swarm server, so every existing tool's reply is checked with the board's additions in it.
  const server = await x.server(accountId, { name: `Compat ${version}`, board: true });
  /** `error` names the error code the call must answer with; a step defaults to that code. */
  const call = async (tool, args, { error = null, step = error ?? "reply" } = {}) => {
    const response = await x.raw(
      "/mcp",
      rpc("tools/call", { name: tool, arguments: args }, credential, version),
    );
    const envelope = await packet(response);
    assert.equal(response.status, 200, JSON.stringify(envelope));
    assert.ok(envelope.result, JSON.stringify(envelope));
    const reply = envelope.result.structuredContent;
    assert.equal(
      envelope.result.isError ?? false,
      error !== null,
      `${tool}: ${JSON.stringify(reply)}`,
    );
    if (error !== null) assert.equal(reply.error.code, error, `${tool}: ${JSON.stringify(reply)}`);
    check(tool, `${step} (${version})`, reply);
    return reply;
  };
  const at = (args) => ({ serverId: server.id, ...args });
  return { server, call, at };
};

/** The calls an agent session makes, in the order a real one makes them. */
const agentFlow = async (x, credential, accountId, check, version) => {
  const { server, call, at } = await session(x, credential, accountId, check, version);
  await call("get_context", {}, { step: "discovery" });
  const registered = await call(
    "register_participant",
    at({
      name: "Ana",
      agentType: "claude-code",
      requestKey: randomUUID(),
      workingDirectory: "/work/talkto",
      joinedNote: "Reviewing the release with Ben.",
    }),
  );
  const ana = registered.data.item.id;
  const general = registered.data.generalConversationId;
  const ben = (
    await call(
      "register_participant",
      at({ name: "Ben", agentType: "codex", requestKey: randomUUID() }),
    )
  ).data.item.id;
  await call(
    "register_participant",
    at({ name: "ana", agentType: "codex", requestKey: randomUUID() }),
    { error: "name_taken" },
  );

  // Both agents report their plugin, so participant lists name agents that have one.
  const scope = { participantId: ana, channelIds: [general], directChats: "own" };
  const started = await call(
    "get_updates",
    at({ ...scope, mode: "start", startAt: "beginning", plugin: "claude-code/0.3.2" }),
    { step: "start with plugin" },
  );
  const benStart = await call(
    "get_updates",
    at({
      participantId: ben,
      channelIds: [general],
      directChats: "own",
      mode: "start",
      startAt: "now",
      plugin: "codex/0.3.2",
    }),
    { step: "start with plugin" },
  );

  await call("get_context", at({}), { step: "server overview" });
  await call("get_context", at({ participant: { id: ana }, directChats: "own" }), {
    step: "own context by id",
  });
  await call("get_context", at({ participant: { name: "Ben" } }), { step: "context by name" });
  await call("get_context", at({ includeInstructions: true }), { step: "with instructions" });

  const channelMessage = await call(
    "send_message",
    at({
      participantId: ben,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: general },
      body: "@Ana the release notes are ready for review.",
    }),
    { step: "channel message with mention" },
  );
  const direct = await call(
    "send_message",
    at({
      participantId: ben,
      requestKey: randomUUID(),
      target: { kind: "direct", recipientId: ana },
      body: "Can you check the migration first?",
      priority: "urgent",
    }),
    { step: "new direct chat, urgent" },
  );
  await call(
    "send_message",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: direct.data.item.conversationId },
      body: "On it.",
    }),
    { step: "reply in direct chat" },
  );
  // Ana asks Ben to confirm in their chat; her next poll carries his confirmation's notice.
  const asking = await call(
    "send_message",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: direct.data.item.conversationId },
      body: "Confirm once the migration is checked.",
      confirm: true,
    }),
    { step: "direct message asking to confirm" },
  );
  await call("confirm_message", at({ participantId: ben, messageId: asking.data.item.id }), {
    step: "confirm",
  });

  const channel = await call(
    "create_channel",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      name: "Releases",
      description: "Release coordination",
    }),
  );
  await call(
    "rename_participant",
    at({ participantId: ben, name: "Ben-release", requestKey: randomUUID() }),
  );

  // The task board: the lead's tasks, a worker's claim and note, an empty claim, and both reads.
  // Ana owns the tasks, so her next poll carries task events and Ben's note with its thread.
  await call(
    "create_tasks",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      tasks: [
        {
          ref: "notes",
          title: "Draft the release notes",
          brief: "Draft the notes, @Ben.",
          labels: ["role=writer"],
        },
        {
          title: "Publish the release",
          brief: "Publish once the notes are done.",
          needs: [{ ref: "notes" }],
          assigneeId: ben,
          priority: "high",
        },
      ],
    }),
  );
  // Swarm memory has no switch: create_tasks above set it up, so claims carry its root map.
  const claimed = await call(
    "claim_task",
    at({ participantId: ben, requestKey: randomUUID(), next: { labels: ["role=writer"] } }),
  );
  const lease = {
    taskId: claimed.data.task.id,
    leaseToken: claimed.data.lease.token,
    epoch: claimed.data.lease.epoch,
  };
  await call(
    "update_task",
    at({
      participantId: ben,
      requestKey: randomUUID(),
      ...lease,
      action: "progress",
      note: "Half of the notes are drafted.",
    }),
    { step: "progress with a note" },
  );
  await call(
    "claim_task",
    at({ participantId: ana, requestKey: randomUUID(), next: { labels: ["role=reviewer"] } }),
    { step: "nothing ready" },
  );
  await call("read_tasks", at({ participantId: ana, mode: "list" }), { step: "list" });
  await call("read_tasks", at({ participantId: ana, mode: "task", task: { number: 1 } }), {
    step: "one task",
  });
  await call("get_context", at({ participant: { id: ben } }), { step: "context with board" });

  // Messages, the channel announcement's notice, the rename notice, the confirmation notice, and
  // plugin-reporting senders.
  const polled = await call(
    "get_updates",
    at({
      participantId: ana,
      mode: "poll",
      checkpoint: started.data.checkpoint,
      plugin: "claude-code/0.3.2",
    }),
    { step: "poll with plugin" },
  );
  assert.ok(
    polled.data.messages.some((item) => item.confirmation?.messageId === asking.data.item.id),
    "the poll carries the confirmation notice",
  );
  const page = await call(
    "get_updates",
    at({ participantId: ben, mode: "poll", checkpoint: benStart.data.checkpoint, limit: 1 }),
    { step: "poll, short page" },
  );
  if (page.data.nextCursor !== null && page.data.nextCursor !== undefined)
    await call(
      "get_updates",
      at({ participantId: ben, mode: "continue", cursor: page.data.nextCursor }),
      {
        step: "continue",
      },
    );

  await call(
    "update_task",
    at({
      participantId: ben,
      requestKey: randomUUID(),
      ...lease,
      action: "complete",
      summary: "Notes drafted",
      details: "The notes are in docs/release.md.",
    }),
    { step: "complete" },
  );
  await call(
    "update_task",
    at({ participantId: ben, requestKey: randomUUID(), ...lease, action: "progress" }),
    { error: "claim_lost" },
  );
  // Swarm memory: the next claim carries the root map, a file is read, and Git access is granted.
  const next = await call(
    "claim_task",
    at({ participantId: ben, requestKey: randomUUID(), next: {} }),
    { step: "claim with memory" },
  );
  assert.match(next.data.memory.root, /^# Swarm memory/, JSON.stringify(next.data));
  await call("read_memory", at({ participantId: ana }), { step: "memory listing" });
  await call("read_memory", at({ participantId: ana, path: "AGENTS.md" }), {
    step: "memory file",
  });
  await call("get_memory_access", at({ participantId: ana }), { step: "read access" });
  await call(
    "get_memory_access",
    at({
      participantId: ben,
      write: {
        taskId: next.data.task.id,
        leaseToken: next.data.lease.token,
        epoch: next.data.lease.epoch,
      },
    }),
    { step: "write access" },
  );
  await call("get_memory_access", at({ participantId: ana, write: { ...lease } }), {
    error: "claim_lost",
  });
  await call(
    "update_task",
    at({
      participantId: ben,
      requestKey: randomUUID(),
      taskId: next.data.task.id,
      leaseToken: next.data.lease.token,
      epoch: next.data.lease.epoch,
      action: "progress",
    }),
    { step: "progress while memory is open" },
  );
  await call(
    "create_tasks",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      tasks: [{ ref: "loop", title: "Loop", brief: "Needs itself.", needs: [{ ref: "loop" }] }],
    }),
    { error: "task_cycle" },
  );
  await call("read_tasks", at({ participantId: ana, mode: "task", task: { number: 99 } }), {
    error: "task_not_found",
  });
  // The thread lives in the board channel: its messages carry their task.
  const board = await call("get_context", at({}), { step: "server with board" });
  await call("read_messages", at({ mode: "history", conversationId: board.data.board.channelId }), {
    step: "board channel history",
  });

  await call("read_messages", at({ mode: "history", conversationId: general }), {
    step: "history",
  });
  await call(
    "read_messages",
    at({ mode: "history", conversationId: direct.data.item.conversationId, limit: 1 }),
    { step: "direct history, one message" },
  );
  await call("read_messages", at({ mode: "search", query: "release" }), { step: "search" });
  await call("read_messages", at({ mode: "around", messageId: channelMessage.data.item.id }), {
    step: "around",
  });

  await call(
    "set_channel_archived",
    at({
      participantId: ana,
      conversationId: channel.data.item.id,
      archived: true,
      expectedRevision: channel.data.item.revision,
    }),
  );

  // A file offer from Ana to Ben: pack, prepare, upload, complete, fetch, read.
  await call("get_pack_command", at({}));
  const prepared = await call(
    "prepare_transfer",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      name: "release.tar.gz",
      kind: "file",
      bytes: 16,
      sha256: sha,
    }),
  );
  const transferId = prepared.data.transferId;
  const key = `r30/${server.id}/${transferId}/payload`;
  const uploaded = await x.control(`transfer-object?key=${encodeURIComponent(key)}&bytes=16`);
  assert.equal(uploaded.status, 200);
  await call(
    "complete_transfer",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      target: { kind: "direct", recipientId: ben },
      transferId,
      body: "The build you asked for.",
    }),
  );
  await call("read_transfer", at({ transferId }), { step: "before fetch" });
  await call("fetch_transfer", at({ participantId: ben, transferId }));
  await call("read_transfer", at({ transferId }), { step: "after fetch" });

  // A task result (docs/swarm-task-results-scope.md): a file TalkTo offers in the thread, and
  // typed links, on the update_task reply, the task, the list and the completed event.
  const results = await call(
    "get_updates",
    at({
      participantId: ana,
      mode: "start",
      startAt: "now",
      channelIds: [general],
      directChats: "own",
      tasks: "all",
    }),
    { step: "start before a result" },
  );
  const handoff = await call(
    "create_tasks",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      tasks: [{ title: "Hand over the fix", brief: "Send a bundle.", assigneeId: ben }],
    }),
    { step: "create for a result" },
  );
  const held = await call(
    "claim_task",
    at({ participantId: ben, requestKey: randomUUID(), taskId: handoff.data.tasks[0].id }),
    { step: "claim for a result" },
  );
  const bundle = await call(
    "prepare_transfer",
    at({
      participantId: ben,
      requestKey: randomUUID(),
      name: "t3.bundle",
      kind: "file",
      bytes: 16,
      sha256: sha,
    }),
    { step: "prepare a result file" },
  );
  const bundleKey = `r30/${server.id}/${bundle.data.transferId}/payload`;
  assert.equal(
    (await x.control(`transfer-object?key=${encodeURIComponent(bundleKey)}&bytes=16`)).status,
    200,
  );
  await call(
    "update_task",
    at({
      participantId: ben,
      requestKey: randomUUID(),
      taskId: held.data.task.id,
      leaseToken: held.data.lease.token,
      epoch: held.data.lease.epoch,
      action: "complete",
      summary: "Fix handed over as a bundle",
      details: "Fetch the bundle and verify it.",
      transferIds: [bundle.data.transferId],
      links: [
        { kind: "commit", role: "base", sha: commit },
        { kind: "commit", role: "head", sha: "1".repeat(40) },
        { kind: "branch", name: "task-3", url: "https://github.com/acme/app/tree/task-3" },
        { kind: "pr", url: "https://github.com/acme/app/pull/3", label: "#3" },
        { kind: "url", url: "https://ci.example.com/run/3", label: "CI run" },
      ],
    }),
    { step: "complete with files and links" },
  );
  await call("read_tasks", at({ participantId: ana, mode: "task", task: { number: 3 } }), {
    step: "a task with a result",
  });
  await call("read_tasks", at({ participantId: ana, mode: "list" }), {
    step: "list with a result",
  });
  await call(
    "get_updates",
    at({ participantId: ana, mode: "poll", checkpoint: results.data.checkpoint }),
    { step: "a completed event with files and links" },
  );

  await call("get_files_access", at({ participantId: ana, scope: "write" }));
  await call(
    "share_file",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: general },
      path: "docs/release.md",
      commit,
      body: "Release checklist for review.",
    }),
  );

  const made = await call(
    "create_agent_invite",
    at({ participantId: ana, note: "for a reviewer", requestKey: randomUUID() }),
  );
  await call("list_agent_invites", at({}));
  await call("revoke_agent_invite", at({ inviteId: made.data.invite.id }));
  await call("create_signal", at(scope));
  await call("revoke_signal", at({ participantId: ana }));
  await call("list_wakes", at({ participantId: ana }));
  await call("revoke_wake", at({ participantId: ana }));
  await call(
    "send_feedback",
    at({
      participantId: ana,
      kind: "bug",
      message: "get_updates returned the same page twice.",
      requestKey: randomUUID(),
    }),
  );

  // Error replies are structured content too, and sessions check them the same way.
  await call(
    "send_message",
    at({
      participantId: ana,
      requestKey: randomUUID(),
      target: { kind: "conversation", conversationId: general },
      body: "",
    }),
    { error: "invalid_input" },
  );
  await call("read_messages", at({ mode: "search", cursor: "not-a-cursor" }), {
    error: "invalid_cursor",
  });
  await call(
    "get_updates",
    at({ ...scope, participantId: randomUUID(), mode: "start", startAt: "now" }),
    { error: "participant_not_found" },
  );
  await call(
    "set_channel_archived",
    at({ participantId: ana, conversationId: general, archived: true, expectedRevision: 1 }),
    { error: "protected_general" },
  );
  await call(
    "send_feedback",
    { kind: "feedback", message: " ", requestKey: randomUUID() },
    {
      error: "invalid_input",
    },
  );
};

// Runs the whole agent flow twice and checks every reply against every committed output-schema
// snapshot: 6 s alone, 29-36 s under a release run's load on boat, and over 60 s on a machine losing
// 40% of its CPU to steal.
const everySnapshot = { timeout: 180_000 };
test(
  "every MCP reply matches every output schema a running session may have cached",
  everySnapshot,
  async (t) => {
    const x = await start(t, everyTool);
    const account = await x.account();
    const credential = await x.mcpToken(account.organizationId);
    const current = await outputSchemas(x.raw, credential);
    // This build lists swarm memory's tools, so their replies are checked against its own schema.
    assert.ok(current.read_memory && current.get_memory_access, "memory tools are listed");
    const { sources, failures, check } = contracts(current);
    assert.ok(sources.length >= 2, "at least one committed snapshot in contracts/mcp-output/");
    const covered = new Set();
    const checking = (tool, step, reply) => {
      covered.add(tool);
      check(tool, step, reply);
    };
    for (const version of ["2026-07-28", "2025-11-25"])
      await agentFlow(x, credential, account.id, checking, version);
    assert.deepEqual(
      Object.keys(current).filter((tool) => !covered.has(tool)),
      [],
      "every listed tool is exercised; add new tools to the flow above",
    );
    const more = failures.length > 12 ? `\n…and ${failures.length - 12} more` : "";
    assert.equal(
      failures.length,
      0,
      `Sessions connected under these releases would refuse replies; keep the reply compatible or plan a reconnect (docs/mcp-compatibility.md):\n${failures.slice(0, 12).join("\n")}${more}`,
    );
  },
);
