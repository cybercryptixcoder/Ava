/**
 * Database schema. Migrations are append-only: add a new entry to MIGRATIONS
 * for any change; never edit an applied one.
 *
 * Conventions: ids are prefixed text (tsk_..., wak_...), timestamps are ISO
 * UTC strings, JSON lives in TEXT columns, and columns ending in _enc hold
 * AES-256-GCM ciphertext (see crypto.ts).
 */
export const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

  -- Life model: structured items -------------------------------------------
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    due_at TEXT, start_at TEXT, end_at TEXT,
    project_id TEXT,
    importance INTEGER,
    tags TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    source_ref TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    touched_at TEXT NOT NULL, status_changed_at TEXT NOT NULL,
    completed_at TEXT, deleted_at TEXT
  );
  CREATE INDEX items_type ON items(type, status);
  CREATE INDEX items_due ON items(due_at);
  CREATE INDEX items_start ON items(start_at);
  CREATE UNIQUE INDEX items_source_ref ON items(source, source_ref) WHERE source_ref IS NOT NULL;

  CREATE TABLE item_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL, at TEXT NOT NULL, field TEXT NOT NULL,
    old_value TEXT, new_value TEXT, via TEXT NOT NULL
  );
  CREATE INDEX item_history_item ON item_history(item_id, at);

  -- Raw evidence, kept apart from beliefs -----------------------------------
  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    summary_enc TEXT,
    content_enc TEXT,
    distilled_at TEXT,
    purge_after TEXT
  );
  CREATE INDEX evidence_kind ON evidence(kind, occurred_at);
  CREATE UNIQUE INDEX evidence_source_ref ON evidence(source, source_ref) WHERE source_ref IS NOT NULL;
  CREATE TABLE item_evidence (item_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY (item_id, evidence_id));

  CREATE TABLE beliefs (
    id TEXT PRIMARY KEY,
    area TEXT NOT NULL,
    statement TEXT NOT NULL,
    subject_item_id TEXT,
    provenance TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    last_confirmed_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE belief_evidence (belief_id TEXT NOT NULL, evidence_id TEXT NOT NULL, note TEXT, PRIMARY KEY (belief_id, evidence_id));

  -- Confirmation chips -------------------------------------------------------
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    change TEXT NOT NULL,
    summary TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL,
    weight REAL,
    evidence_id TEXT,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX proposals_batch ON proposals(batch_id);
  CREATE INDEX proposals_status ON proposals(status, origin);

  -- Rules --------------------------------------------------------------------
  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    tier TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence TEXT,
    definition TEXT,
    params TEXT,
    action_kind TEXT NOT NULL,
    approval_tier TEXT NOT NULL,
    status TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    expires_at TEXT,
    expiry TEXT,
    created_by TEXT NOT NULL,
    revision_of TEXT,
    proposed_revision TEXT,
    shadow TEXT,
    paused_reason TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, approved_at TEXT
  );

  CREATE TABLE rule_firings (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    wake_id TEXT,
    at TEXT NOT NULL,
    item_ids TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    outcome TEXT NOT NULL,
    message_id TEXT,
    detail TEXT
  );
  CREATE INDEX rule_firings_rule ON rule_firings(rule_id, at);
  CREATE INDEX rule_firings_dedupe ON rule_firings(dedupe_key, at);

  CREATE TABLE cooldowns (key TEXT PRIMARY KEY, until TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);

  -- Wakes --------------------------------------------------------------------
  CREATE TABLE wakes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    due_at TEXT NOT NULL,
    anchor TEXT,
    status TEXT NOT NULL,
    owner TEXT NOT NULL,
    reason TEXT NOT NULL,
    item_ids TEXT NOT NULL DEFAULT '[]',
    payload TEXT NOT NULL DEFAULT '{}',
    dedupe_key TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT, finished_at TEXT,
    outcome TEXT, error TEXT
  );
  CREATE INDEX wakes_due ON wakes(status, due_at);
  CREATE INDEX wakes_dedupe ON wakes(dedupe_key);

  -- Messages -----------------------------------------------------------------
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    rule_id TEXT,
    wake_id TEXT,
    headline TEXT NOT NULL,
    because_template TEXT,
    because TEXT NOT NULL,
    cited TEXT NOT NULL,
    options TEXT NOT NULL,
    urgency TEXT NOT NULL,
    status TEXT NOT NULL,
    block_reason TEXT,
    dedupe_key TEXT,
    drafted_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    response TEXT, response_option TEXT, responded_at TEXT,
    acted INTEGER
  );
  CREATE INDEX messages_created ON messages(created_at);
  CREATE INDEX messages_rule ON messages(rule_id);

  -- Decision log and model calls --------------------------------------------
  CREATE TABLE log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    wake_id TEXT,
    kind TEXT NOT NULL,
    level TEXT NOT NULL,
    summary TEXT NOT NULL,
    data TEXT
  );
  CREATE INDEX log_at ON log(at);
  CREATE INDEX log_wake ON log(wake_id);

  CREATE TABLE model_calls (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    purpose TEXT NOT NULL,
    origin TEXT NOT NULL,
    model TEXT NOT NULL,
    wake_id TEXT,
    status TEXT NOT NULL,
    input_enc TEXT,
    output_enc TEXT,
    usage TEXT,
    latency_ms INTEGER,
    cost_usd REAL,
    error TEXT
  );
  CREATE INDEX model_calls_at ON model_calls(at);

  CREATE TABLE daily_counters (date TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (date, key));

  -- Planning -----------------------------------------------------------------
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    for_date TEXT,
    content TEXT NOT NULL,
    model_call_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE plan_blocks (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL,
    item_id TEXT,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL
  );
  CREATE INDEX plan_blocks_start ON plan_blocks(start_at);
  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    why TEXT NOT NULL,
    about TEXT,
    status TEXT NOT NULL,
    answer TEXT,
    created_at TEXT NOT NULL,
    asked_at TEXT,
    answered_at TEXT
  );
  CREATE TABLE briefs (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    spoken TEXT NOT NULL,
    modules TEXT NOT NULL,
    question_id TEXT,
    message_ids TEXT NOT NULL,
    audio_id TEXT,
    drafted_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Conversation and canvas -------------------------------------------------
  CREATE TABLE conversations (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, title TEXT);
  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    mode TEXT NOT NULL,
    text_enc TEXT NOT NULL,
    raw_enc TEXT,
    input_kind TEXT,
    operational INTEGER NOT NULL DEFAULT 0,
    affirmation INTEGER NOT NULL DEFAULT 0,
    trimmed INTEGER NOT NULL DEFAULT 0,
    audio_id TEXT,
    cues TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX turns_conv ON turns(conversation_id, created_at);
  CREATE TABLE canvas_modules (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    key TEXT NOT NULL,
    type TEXT NOT NULL,
    spec TEXT NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX canvas_key ON canvas_modules(conversation_id, key);
  CREATE TABLE canvas_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    module_key TEXT,
    kind TEXT NOT NULL,
    detail TEXT,
    at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE style_notes (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source_turn_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );

  -- Executors and external actions ------------------------------------------
  CREATE TABLE exec_tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    spec TEXT NOT NULL,
    item_id TEXT,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    sessions_run INTEGER NOT NULL DEFAULT 0,
    max_sessions INTEGER NOT NULL,
    progress_note TEXT,
    plan_fit TEXT,
    error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    exec_task_id TEXT,
    item_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body_enc TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE external_actions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_enc TEXT NOT NULL,
    status TEXT NOT NULL,
    artifact_id TEXT,
    created_at TEXT NOT NULL,
    confirmed_at TEXT, executed_at TEXT,
    result TEXT
  );

  -- Sources ------------------------------------------------------------------
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT '{}',
    secrets_enc TEXT,
    last_sync_at TEXT,
    last_error TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE ics_feeds (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    url_enc TEXT NOT NULL,
    kind TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    etag TEXT,
    last_fetch_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE activity_sessions (
    id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    app TEXT NOT NULL,
    title_enc TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    active_seconds INTEGER NOT NULL,
    label TEXT,
    category TEXT,
    item_id TEXT,
    labeled_at TEXT,
    purge_title_after TEXT
  );
  CREATE INDEX activity_started ON activity_sessions(started_at);

  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL UNIQUE,
    keys_enc TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_ok_at TEXT,
    failures INTEGER NOT NULL DEFAULT 0
  );

  -- Snapshots for shadow replay; audio; auth; voice -------------------------
  CREATE TABLE snapshots (id TEXT PRIMARY KEY, wake_id TEXT, at TEXT NOT NULL, state TEXT NOT NULL);
  CREATE INDEX snapshots_at ON snapshots(at);
  CREATE TABLE audio_files (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    mime TEXT NOT NULL,
    timings TEXT,
    created_at TEXT NOT NULL,
    purge_after TEXT
  );
  CREATE TABLE auth_sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, user_agent TEXT);
  CREATE TABLE latency_samples (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    mode TEXT NOT NULL,
    model TEXT NOT NULL,
    tts TEXT NOT NULL,
    stt TEXT NOT NULL,
    stages TEXT NOT NULL,
    total_ms INTEGER
  );
  CREATE TABLE personality_runs (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    voice_hash TEXT NOT NULL,
    label TEXT,
    results TEXT NOT NULL
  );
  `,
  /* 2: threads, cards, auto-filing with undo */ `
  ALTER TABLE items ADD COLUMN thread_id TEXT;
  ALTER TABLE items ADD COLUMN parent_id TEXT;
  CREATE INDEX items_thread ON items(thread_id);
  CREATE INDEX items_parent ON items(parent_id);
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    parent_id TEXT,
    merged_into TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    ref_id TEXT,
    thread_id TEXT,
    item_ids TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL,
    why TEXT,
    options TEXT NOT NULL DEFAULT '[]',
    data TEXT NOT NULL DEFAULT '{}',
    priority REAL NOT NULL DEFAULT 0,
    time_sensitive INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    visible_from TEXT NOT NULL,
    snoozed_until TEXT,
    expires_at TEXT,
    returns INTEGER NOT NULL DEFAULT 0,
    pushed_at TEXT,
    response TEXT,
    responded_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX cards_status ON cards(status, visible_from);
  CREATE INDEX cards_ref ON cards(source, ref_id);
  ALTER TABLE proposals ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE proposals ADD COLUMN undo TEXT;
  `,
  /* 3: the raw log (L0), its links, and memory bookkeeping */ `
  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    role TEXT,
    session_id TEXT,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    text_enc TEXT NOT NULL,
    raw_enc TEXT,
    meta TEXT NOT NULL DEFAULT '{}',
    deleted_at TEXT,
    deleted_reason TEXT
  );
  CREATE INDEX entries_time ON entries(recorded_at);
  CREATE INDEX entries_kind ON entries(kind, occurred_at);
  CREATE INDEX entries_session ON entries(session_id, recorded_at);

  CREATE TABLE entry_links (
    entry_id TEXT NOT NULL,
    rel TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (entry_id, rel, target_kind, target_id)
  );
  CREATE INDEX entry_links_target ON entry_links(target_kind, target_id);

  CREATE TABLE memory_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  /* 4: episodes, gists and fact keys — the first derived layer */ `
  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    session_id TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    gist_enc TEXT,
    keywords_enc TEXT,
    entities_enc TEXT,
    importance REAL NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    stale INTEGER NOT NULL DEFAULT 0,
    revised_at TEXT
  );
  CREATE INDEX episodes_span ON episodes(start_at);
  CREATE INDEX episodes_session ON episodes(session_id, end_at);
  CREATE TABLE episode_entries (
    episode_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (episode_id, entry_id)
  );
  CREATE INDEX episode_entries_entry ON episode_entries(entry_id);

  CREATE TABLE facts (
    id TEXT PRIMARY KEY,
    statement_enc TEXT NOT NULL,
    keywords_enc TEXT,
    entities_enc TEXT,
    refers_at TEXT,
    recorded_at TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    superseded_by TEXT,
    canonical_id TEXT,
    provenance TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.8,
    importance REAL NOT NULL DEFAULT 0.5,
    thread_id TEXT,
    item_id TEXT,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'current',
    created_at TEXT NOT NULL
  );
  CREATE INDEX facts_recorded ON facts(recorded_at);
  CREATE INDEX facts_status ON facts(status);
  CREATE TABLE fact_entries (fact_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY (fact_id, entry_id));
  CREATE INDEX fact_entries_entry ON fact_entries(entry_id);
  `,
  /* 5: embeddings (encrypted vectors) for semantic memory search */ `
  CREATE TABLE memory_embeddings (
    ref_kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vec_enc TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (ref_kind, ref_id, model)
  );
  CREATE INDEX memory_embeddings_model ON memory_embeddings(model, ref_kind);
  `,
];
