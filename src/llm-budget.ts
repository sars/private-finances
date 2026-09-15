import type { Executor } from './database.js';

export const LLM_OUTPUT_TOKEN_LIMIT = 512;
export const LLM_BUDGET_NANO = 10_000_000_000n;
export const LLM_SAFETY_NANO = 500_000_000n;
const ceiling = LLM_BUDGET_NANO - LLM_SAFETY_NANO;
export const PRICED_MODELS = ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'];
const price = { input: 750n, cached: 75n, output: 4500n };
const legacyHold = 400_000n * price.input + 4096n * price.output;
const monthSql = "to_char(now() AT TIME ZONE 'Europe/Riga','YYYY-MM')";
export function usd(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const v = value < 0n ? -value : value;
  return `${sign}${v / 1_000_000_000n}.${(v % 1_000_000_000n).toString().padStart(9, '0')}`;
}
export async function initializeLlmBudget(tx: Executor): Promise<void> {
  await tx.query(`CREATE TABLE IF NOT EXISTS llm_cost_ledger (
    proposal_id uuid PRIMARY KEY REFERENCES classifier_proposals(id),
    month text NOT NULL CHECK(month ~ '^[0-9]{4}-[0-9]{2}$'), model text NOT NULL,
    state text NOT NULL CHECK(state IN ('reserved','measured','uncertain','legacy')),
    held_nano bigint NOT NULL CHECK(held_nano>=0), spent_nano bigint NOT NULL DEFAULT 0 CHECK(spent_nano>=0),
    input_price_nano bigint NOT NULL, cached_price_nano bigint NOT NULL, output_price_nano bigint NOT NULL,
    input_tokens integer, cached_tokens integer, output_tokens integer, response_id text,
    created_at timestamptz NOT NULL DEFAULT now(), settled_at timestamptz
  )`);
  await tx.query(
    'CREATE INDEX IF NOT EXISTS llm_cost_month ON llm_cost_ledger(month)',
  );
  await tx.query(
    `CREATE TABLE IF NOT EXISTS llm_budget_metadata (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), tracking_started_at timestamptz NOT NULL DEFAULT now(), pause_reason text)`,
  );
  await tx.query(
    'INSERT INTO llm_budget_metadata(singleton) VALUES(true) ON CONFLICT DO NOTHING',
  );
  await tx.query(
    `INSERT INTO llm_cost_ledger(proposal_id,month,model,state,held_nano,input_price_nano,cached_price_nano,output_price_nano,created_at)
    SELECT id,to_char(created_at AT TIME ZONE 'Europe/Riga','YYYY-MM'),model,'legacy',
    CASE WHEN model=ANY($2::text[]) THEN $1::bigint ELSE $3::bigint END,750,75,4500,created_at FROM classifier_proposals
    ON CONFLICT(proposal_id) DO NOTHING`,
    [String(legacyHold), PRICED_MODELS, String(LLM_BUDGET_NANO)],
  );
}
export function reservationCost(body: Record<string, unknown>): bigint | null {
  if (typeof body.model !== 'string' || !PRICED_MODELS.includes(body.model))
    return null;
  const output = body.max_output_tokens;
  if (
    !Number.isSafeInteger(output) ||
    Number(output) < 128 ||
    Number(output) > 4096 ||
    body.service_tier !== 'default'
  )
    return null;
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > 100_000) return null;
  // Reserve the entire documented context, not a tokenizer/hidden-overhead estimate.
  return 400_000n * price.input + BigInt(Number(output)) * price.output;
}
/** Caller holds classifier advisory lock until proposal and reservation are committed. */
export async function canReserveLlm(
  tx: Executor,
  amount: bigint,
): Promise<boolean> {
  if (
    (
      await tx.query(
        'SELECT pause_reason FROM llm_budget_metadata WHERE singleton',
      )
    ).rows[0]?.pause_reason
  )
    return false;
  const row = (
    await tx.query(
      `SELECT COALESCE(sum(spent_nano+held_nano),0)::text AS used FROM llm_cost_ledger WHERE month=${monthSql}`,
    )
  ).rows[0]!;
  return BigInt(String(row.used)) + amount <= ceiling;
}
export async function reserveLlm(
  tx: Executor,
  id: string,
  model: string,
  amount: bigint,
): Promise<void> {
  await tx.query(
    `INSERT INTO llm_cost_ledger(proposal_id,month,model,state,held_nano,input_price_nano,cached_price_nano,output_price_nano) VALUES($1,${monthSql},$2,'reserved',$3,750,75,4500)`,
    [id, model, String(amount)],
  );
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export async function settleLlm(
  db: Executor,
  id: string,
  raw: unknown,
): Promise<void> {
  const response = object(raw);
  const usage = object(response?.usage);
  const details = object(usage?.input_tokens_details);
  const input = usage?.input_tokens,
    output = usage?.output_tokens,
    cached = details?.cached_tokens;
  const ledger = (
    await db.query(
      'SELECT held_nano::text,state,model FROM llm_cost_ledger WHERE proposal_id=$1',
      [id],
    )
  ).rows[0];
  if (!ledger || ledger.state === 'measured' || ledger.state === 'legacy')
    return;
  const maxOutput =
    (BigInt(String(ledger.held_nano)) - 400_000n * price.input) / price.output;
  const unexpected =
    response !== null &&
    ((response.model !== undefined &&
      response.model !== ledger.model &&
      !(
        PRICED_MODELS.includes(String(response.model)) &&
        PRICED_MODELS.includes(String(ledger.model))
      )) ||
      (response.service_tier !== undefined &&
        response.service_tier !== 'default'));
  const overrun =
    (typeof input === 'number' && input > 400_000) ||
    (typeof output === 'number' && output > Number(maxOutput));
  if (unexpected || overrun)
    await db.query(
      "UPDATE llm_budget_metadata SET pause_reason='pricing_or_usage_anomaly' WHERE singleton",
    );
  const valid =
    !unexpected &&
    !overrun &&
    Number(input) <= 400_000 &&
    Number(output) <= Number(maxOutput) &&
    [input, output, cached].every(
      (v) =>
        typeof v === 'number' &&
        Number.isSafeInteger(v) &&
        v >= 0 &&
        v <= 1_000_000,
    ) &&
    Number(cached) <= Number(input);
  const responseId =
    typeof response?.id === 'string' &&
    /^resp_[A-Za-z0-9_-]{1,180}$/.test(response.id)
      ? response.id
      : null;
  if (!valid) {
    await db.query(
      "UPDATE llm_cost_ledger SET state='uncertain',response_id=$2 WHERE proposal_id=$1 AND state='reserved'",
      [id, responseId],
    );
    return;
  }
  await db.query(
    `UPDATE llm_cost_ledger SET state='measured',held_nano=0,
    spent_nano=($2::bigint-$3::bigint)*input_price_nano+$3::bigint*cached_price_nano+$4::bigint*output_price_nano,
    input_tokens=$2,cached_tokens=$3,output_tokens=$4,response_id=$5,settled_at=now()
    WHERE proposal_id=$1 AND state IN ('reserved','uncertain')`,
    [id, input, cached, output, responseId],
  );
}
export async function llmBudgetSummary(db: Executor) {
  const clock = (
    await db.query(`SELECT ${monthSql} AS month,to_char(now() AT TIME ZONE 'Europe/Riga','YYYY-MM-DD') AS day,
    extract(day FROM now() AT TIME ZONE 'Europe/Riga')::integer AS elapsed,
    extract(day FROM (date_trunc('month',now() AT TIME ZONE 'Europe/Riga')+interval '1 month - 1 day'))::integer AS days,
    (SELECT tracking_started_at FROM llm_budget_metadata WHERE singleton) AS started, (SELECT pause_reason FROM llm_budget_metadata WHERE singleton) AS pause_reason, extract(epoch FROM (now()-greatest((SELECT tracking_started_at FROM llm_budget_metadata WHERE singleton),date_trunc('month',now() AT TIME ZONE 'Europe/Riga') AT TIME ZONE 'Europe/Riga')))::numeric AS observed_seconds, extract(epoch FROM ((date_trunc('month',now() AT TIME ZONE 'Europe/Riga')+interval '1 month') AT TIME ZONE 'Europe/Riga'-now()))::numeric AS remaining_seconds`)
  ).rows[0]!;
  const rows = (
    await db.query(
      `SELECT model,state,spent_nano::text,held_nano::text,to_char(created_at AT TIME ZONE 'Europe/Riga','YYYY-MM-DD') AS day FROM llm_cost_ledger WHERE month=$1`,
      [clock.month],
    )
  ).rows;
  let spent = 0n,
    held = 0n,
    measured = 0,
    uncertain = 0,
    legacy = 0,
    reserved = 0;
  const daily = new Map<string, { spent: bigint; held: bigint }>();
  const models = new Map<
    string,
    { spent: bigint; held: bigint; requests: number }
  >();
  for (const row of rows) {
    const s = BigInt(String(row.spent_nano)),
      h = BigInt(String(row.held_nano));
    spent += s;
    held += h;
    if (row.state === 'measured') measured++;
    else if (row.state === 'legacy') legacy++;
    else if (row.state === 'uncertain') uncertain++;
    else reserved++;
    const d = daily.get(String(row.day)) ?? { spent: 0n, held: 0n };
    d.spent += s;
    d.held += h;
    daily.set(String(row.day), d);
    const m = models.get(String(row.model)) ?? {
      spent: 0n,
      held: 0n,
      requests: 0,
    };
    m.spent += s;
    m.held += h;
    m.requests++;
    models.set(String(row.model), m);
  }
  const available = ceiling - spent - held;
  const observed = Math.floor(Number(clock.observed_seconds));
  const projected =
    measured > 0 && observed >= 172800
      ? spent +
        (spent *
          BigInt(Math.max(0, Math.floor(Number(clock.remaining_seconds))))) /
          BigInt(observed)
      : null;
  return {
    month: String(clock.month),
    timezone: 'Europe/Riga',
    budgetUsd: usd(LLM_BUDGET_NANO),
    safetyReserveUsd: usd(LLM_SAFETY_NANO),
    spentUsd: usd(spent),
    heldUsd: usd(held),
    remainingUsd: usd(available > 0n ? available : 0n),
    requestCount: rows.length,
    measuredRequests: measured,
    uncertainRequests: uncertain,
    reservedRequests: reserved,
    legacyRequests: legacy,
    projectedUsd: projected === null ? null : usd(projected),
    pauseReason: clock.pause_reason
      ? String(clock.pause_reason)
      : available <
          400_000n * price.input + BigInt(LLM_OUTPUT_TOKEN_LIMIT) * price.output
        ? 'monthly_budget'
        : null,
    state:
      clock.pause_reason ||
      available <
        400_000n * price.input + BigInt(LLM_OUTPUT_TOKEN_LIMIT) * price.output
        ? ('paused' as const)
        : spent + held >= (ceiling * 8n) / 10n ||
            (projected !== null && projected > ceiling)
          ? ('warning' as const)
          : ('healthy' as const),
    daily: [...daily]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, d]) => ({
        date,
        spentUsd: usd(d.spent),
        heldUsd: usd(d.held),
      })),
    byModel: [...models]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, m]) => ({
        model,
        requests: m.requests,
        spentUsd: usd(m.spent),
        heldUsd: usd(m.held),
      })),
    trackingStartedAt: new Date(String(clock.started)).toISOString(),
  };
}
