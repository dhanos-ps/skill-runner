# Skill Runner

A lightweight agent runtime that deploys AI skills as containerized services. Built with [Bun](https://bun.sh/) and the [Anthropic SDK](https://docs.anthropic.com/en/api/getting-started).

Skills are self-contained packages — a workflow prompt, a set of allowed tools, and a security manifest — that Claude executes in a sandboxed environment. Upload a file, get a result. Each skill runs as a stateless job with audit logging, path containment, and tool-call limits enforced by the runtime.

Includes an optional Slack bot that registers slash commands from skill manifests automatically.

## Architecture

```
Slack Bot (/summarize "topic")         HTTP Client (POST /jobs)
         │                                       │
         └──── file upload ──────┐               │
                                 ▼               ▼
                          ┌─────────────────────────┐
                          │     Bun HTTP Server      │
                          │     (src/server.ts)       │
                          ├─────────────────────────┤
                          │  Job Runner              │
                          │  ├─ Load workflow prompt  │
                          │  ├─ Build tool definitions│
                          │  └─ Anthropic tool-use   │
                          │     loop until end_turn   │
                          ├─────────────────────────┤
                          │  Security Layer          │
                          │  ├─ Path containment     │
                          │  ├─ Banned tools/fields  │
                          │  ├─ Tool call limits     │
                          │  ├─ Duration limits      │
                          │  └─ Audit log (JSONL)    │
                          ├─────────────────────────┤
                          │  Tool Executor           │
                          │  ├─ Array-form spawn     │
                          │  │   (no shell injection) │
                          │  ├─ Built-in write_file  │
                          │  └─ Context file reader   │
                          └─────────────────────────┘
                                     │
                              ┌──────┴──────┐
                              │  Job Store  │
                              │  (local fs) │
                              └─────────────┘
```

## How Skills Work

A skill is a directory under `skills/` with:

```
skills/_Example/
├── deploy.json              # Manifest: tools, security limits, Slack config
└── Workflows/
    └── Summarize.md         # Workflow prompt — Claude's instructions
```

**`deploy.json`** declares:
- **Tools** — what commands Claude can run, with input schemas and path containment rules
- **Security** — max tool calls, max duration, upload size limits, path containment toggle
- **Slack** (optional) — slash command name, intro message template, parameter mapping

**Workflow markdown** is the system prompt. It tells Claude what to do step-by-step: discover input files, process them with the declared tools, write output.

The runtime enforces the manifest. Claude can only call tools listed in `deploy.json`. All file paths are resolved and contained to the job directory. Banned tool names (`bash`, `exec`, `shell`, etc.) and banned input fields (`command`, `eval`, `code`, etc.) are rejected at validation time.

## Security Model

Every tool call passes through validation before execution:

1. **Tool allowlist** — only tools declared in the skill manifest can be called
2. **Banned names** — `bash`, `exec`, `shell`, `eval`, `spawn`, etc. are rejected
3. **Banned fields** — input fields named `command`, `code`, `script`, etc. are rejected
4. **Path containment** — all path fields are resolved (including symlinks), URL-decoded, and checked against the job root directory
5. **Violation escalation** — 3 security violations terminate the job
6. **Array-form spawn** — subprocesses are spawned as arrays, never shell strings
7. **Audit trail** — every tool call logged to `audit.jsonl` with input hashes, timing, and outcome

## Setup

### Prerequisites

- [Bun](https://bun.sh/) 1.2+
- An [Anthropic API key](https://console.anthropic.com/)

### Local Development

```bash
git clone https://github.com/dhanos-ps/skill-runner.git
cd skill-runner

bun install

cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY

bun run dev
```

The server starts on `http://localhost:8080`.

### Docker

```bash
docker compose up --build
```

This starts both the API server and the Slack bot (if Slack tokens are configured).

## API

### Create a job

```bash
curl -X POST http://localhost:8080/jobs \
  -H "Content-Type: application/json" \
  -d '{"skill": "_Example", "workflow": "Summarize", "params": {"topic": "meeting notes"}}'
```

Returns: `{"jobId": "uuid", "status": "pending"}`

### Upload files and start

```bash
curl -X POST http://localhost:8080/jobs/{jobId}/upload \
  -F "file=@notes.txt"
```

Uploading files triggers the job to start. Files are classified by extension into input subdirectories.

### Stream progress (SSE)

```bash
curl http://localhost:8080/jobs/{jobId}/stream
```

Events: `tool_call`, `tool_result`, `text_delta`, `complete`, `error`

### Download output

```bash
curl http://localhost:8080/jobs/{jobId}/output/summary.md -o summary.md
```

### Check status

```bash
curl http://localhost:8080/jobs/{jobId}
```

### Cancel

```bash
curl -X DELETE http://localhost:8080/jobs/{jobId}
```

## Creating a Skill

1. Create a directory under `skills/`:

```
skills/_MySkill/
├── deploy.json
└── Workflows/
    └── MyWorkflow.md
```

2. Define tools in `deploy.json`. Each tool needs:
   - `name`, `description` — for Claude's tool-use interface
   - `command`, `args` — the executable and base arguments
   - `input_schema` — JSON Schema for Claude's inputs
   - `input_map` — how input fields map to command arguments
   - `path_fields` — which input fields should be path-contained

3. Write the workflow prompt. Reference tools by name. Use `{input_dir}` and `{output_dir}` placeholders — the runtime substitutes them.

4. Set security limits in `deploy.json`:

```json
{
  "security": {
    "path_containment": true,
    "max_tool_calls_per_job": 20,
    "max_job_duration_seconds": 300,
    "max_upload_size_mb": 10,
    "audit_log": true
  }
}
```

5. (Optional) Add a `slack` block to register a slash command automatically.

See `skills/_Example/` for a complete working example.

## Slack Bot

The bot auto-discovers skills with a `slack` block in their manifest. For each skill, it registers the declared slash command.

**Flow:** User runs `/summarize meeting notes` → bot posts intro message → user uploads a file in the thread → bot creates a job, uploads the file, polls for completion, delivers the output file back to the thread.

**Required env vars:**
- `SLACK_BOT_TOKEN` — Bot User OAuth Token (`xoxb-...`)
- `SLACK_APP_TOKEN` — App-Level Token (`xapp-...`) for Socket Mode
- `SLACK_SIGNING_SECRET` — Request signing secret

See `slack-app-manifest.yaml` for the required bot scopes and event subscriptions.

## Project Structure

```
skill-runner/
├── src/
│   ├── server.ts              # Bun HTTP server, routing
│   ├── types.ts               # Job, ToolDefinition, DeployManifest types
│   └── lib/
│       ├── job-runner.ts      # Anthropic tool-use loop
│       ├── tool-executor.ts   # Validation, path containment, execution
│       ├── manifest.ts        # Manifest loading and validation
│       ├── audit.ts           # JSONL audit logging
│       └── store/             # Job file storage (local fs, extensible)
├── bot/
│   └── src/
│       ├── index.ts           # Slack Bolt app, Socket Mode
│       ├── skills.ts          # Auto-discover skills with Slack config
│       ├── pai-client.ts      # HTTP client for the API server
│       ├── state.ts           # Pending job tracking with TTL
│       └── handlers/
│           ├── command.ts     # Slash command → create pending job
│           └── file-upload.ts # File shared → upload + poll + deliver
├── skills/
│   └── _Example/              # Example skill (see "Creating a Skill")
├── Dockerfile                 # Multi-stage Bun build
├── docker-compose.yml         # API + bot services
├── slack-app-manifest.yaml    # Slack app configuration
└── .env.example               # Environment variable template
```

## License

MIT
