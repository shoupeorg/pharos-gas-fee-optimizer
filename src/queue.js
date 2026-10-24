import { Transaction, Wallet, isAddress } from "ethers";
import { costComparison, nextWake, releaseDecision, safeToSubmit, validateJob } from "./engine.js";
import { hex, quantity, rpc } from "./rpc.js";
import { ENGINE_VERSION, NETWORK, TERMINAL } from "./constants.js";

const JOB_PREFIX = "job:", HISTORY = "gas-history", LEDGER = "spend-ledger", RATE = "rate-window";
const LEASE_MS = 30_000, RECEIPT_POLL_MS = 10_000, STUCK_AFTER_MS = 30 * 60_000, MAX_SEND_ATTEMPTS = 3;
const ACTIVE = new Set(["QUEUED", "WAITING_FOR_GAS", "READY_FAVORABLE", "READY_DEADLINE", "SUBMITTING", "BROADCAST", "FEE_ACCOUNTING_PENDING", "UNRESOLVED"]);
const PRE_SUBMISSION = new Set(["QUEUED", "WAITING_FOR_GAS", "READY_FAVORABLE", "READY_DEADLINE"]);
const iso = value => new Date(value).toISOString(), uid = () => crypto.randomUUID(), HASH = /^0x[0-9a-f]{64}$/i;
const sameHash = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

function publicJob(job) { if (!job) return null; const { signedRawTransaction, submissionLeaseId, ...safe } = job; return safe; }
function move(job, state, at, reason, extra = {}) { job.state = state; job.timeline.push({ state, at: iso(at), reason }); Object.assign(job, extra); }

export class GasQueue {
  constructor(state, env) { this.state = state; this.storage = state.storage; this.env = env; }
  config() { return { allowedRecipient: this.env.ALLOWED_RECIPIENT, maxTransferWei: this.env.MAX_TRANSFER_WEI, maxTotalSpendWei: this.env.MAX_TOTAL_SPEND_WEI }; }
  json(data, status = 200) { return Response.json(data, { status }); }

  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/jobs" && req.method === "GET") return this.json({ jobs: await this.listJobs() });
      if (url.pathname === "/history" && req.method === "GET") return this.json({ observations: (await this.storage.get(HISTORY)) || [] });
      if (url.pathname === "/jobs" && req.method === "POST") return this.json(await this.create(await req.json()), 201);
      const match = url.pathname.match(/^\/jobs\/([^/]+)(?:\/(cancel|run))?$/);
      if (!match) return this.json({ error: "Not found." }, 404);
      const job = await this.storage.get(JOB_PREFIX + match[1]);
      if (!job) return this.json({ error: "Job not found." }, 404);
      if (req.method === "GET") return this.json({ job: publicJob(job) });
      if (req.method === "POST" && match[2] === "cancel") return this.json(await this.cancel(job.id));
      if (req.method === "POST" && match[2] === "run") return this.json({ job: publicJob(await this.process(job.id, Date.now())) });
      return this.json({ error: "Not found." }, 404);
    } catch (error) { return this.json({ error: error.message }, error.status || 400); }
  }

  async listJobs() { const map = await this.storage.list({ prefix: JOB_PREFIX }); return [...map.values()].map(publicJob).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)); }

  wallet() {
    if (!this.env.DEMO_SIGNER_PRIVATE_KEY || !this.env.DEMO_SIGNER_ADDRESS || !isAddress(this.env.DEMO_SIGNER_ADDRESS)) throw new Error("Restricted demo signer is not safely configured.");
    const wallet = new Wallet(this.env.DEMO_SIGNER_PRIVATE_KEY);
    if (wallet.address.toLowerCase() !== this.env.DEMO_SIGNER_ADDRESS.toLowerCase()) throw new Error("Configured signer address does not match the secret key.");
    return wallet;
  }

  async verifyChain() { const observed = quantity(await rpc(this.env.ATLANTIC_RPC_URL, "eth_chainId"), "eth_chainId"); if (observed !== BigInt(NETWORK.chainId)) throw new Error(`RPC chain mismatch: expected ${NETWORK.chainId}, received ${observed}.`); }

  async recordObservation(observation) {
    await this.storage.transaction(async txn => { const history = (await txn.get(HISTORY)) || []; history.push(observation); await txn.put(HISTORY, history.slice(-200)); });
  }

  async observeGas(required = false) {
    try {
      const [priceRaw, blockRaw] = await Promise.all([rpc(this.env.ATLANTIC_RPC_URL, "eth_gasPrice"), rpc(this.env.ATLANTIC_RPC_URL, "eth_blockNumber")]);
      const now = Date.now(), observation = { observedAt: iso(now), observedAtMs: now, chainId: NETWORK.chainId, blockNumber: quantity(blockRaw, "eth_blockNumber").toString(), gasPriceWei: quantity(priceRaw, "eth_gasPrice").toString(), source: "Pharos Atlantic JSON-RPC job-processing observation", error: null };
      await this.recordObservation(observation); return observation;
    } catch (error) {
      const now = Date.now(), observation = { observedAt: iso(now), observedAtMs: now, chainId: NETWORK.chainId, blockNumber: null, gasPriceWei: null, source: "Pharos Atlantic JSON-RPC job-processing observation", error: { message: error.message, code: error.code ?? null } };
      await this.recordObservation(observation); if (required) throw error; return observation;
    }
  }

  async rescheduleTxn(txn) {
    const jobs = await txn.list({ prefix: JOB_PREFIX });
    const next = [...jobs.values()].filter(job => ACTIVE.has(job.state) && Number.isFinite(job.nextCheckMs)).sort((a, b) => a.nextCheckMs - b.nextCheckMs)[0];
    if (next) await txn.setAlarm(next.nextCheckMs); else await txn.deleteAlarm();
  }

  async mutate(jobId, expectedRevision, allowed, update) {
    return this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + jobId);
      if (!current || current.revision !== expectedRevision || !allowed.has(current.state)) return { ok: false, job: current };
      await update(current, txn); current.revision += 1; await txn.put(JOB_PREFIX + jobId, current); await this.rescheduleTxn(txn); return { ok: true, job: current };
    });
  }

  async accept(input) {
    const receivedAt = Date.now(), config = this.config(), wallet = this.wallet(), normalized = validateJob(input, receivedAt, config);
    const existing = await this.storage.list({ prefix: JOB_PREFIX });
    if ([...existing.values()].some(saved => ACTIVE.has(saved.state))) throw new Error("Only one outstanding job is supported; wait for terminal resolution before accepting another.");
    await this.verifyChain();
    const observation = await this.observeGas(true), transaction = { from: wallet.address, to: normalized.recipient, value: hex(normalized.valueWei), data: "0x" };
    const [estimateRaw, balanceRaw] = await Promise.all([rpc(this.env.ATLANTIC_RPC_URL, "eth_estimateGas", [transaction]), rpc(this.env.ATLANTIC_RPC_URL, "eth_getBalance", [wallet.address, "latest"])]);
    const gasLimit = quantity(estimateRaw, "eth_estimateGas"), balance = quantity(balanceRaw, "eth_getBalance"), gasPrice = BigInt(observation.gasPriceWei), acceptedAt = Date.now();
    if (gasLimit <= 0n) throw new Error("Gas estimate must be positive.");
    if (normalized.deadlineMs <= acceptedAt + 15_000) throw new Error("Deadline became infeasible during acceptance checks; choose a later UTC deadline.");
    const value = BigInt(normalized.valueWei), maxFee = BigInt(normalized.maxAuthorizedFeeWei), baseline = gasLimit * gasPrice, requestedReserve = value + maxFee;
    if (balance < requestedReserve) throw new Error("Demo signer funding is insufficient for value plus the authorized maximum fee.");
    if (baseline > maxFee) throw new Error("Initial estimated fee exceeds the job's maximum authorized fee.");
    const job = {
      id: uid(), revision: 0, engineVersion: ENGINE_VERSION, state: "QUEUED", phase: "ACCEPTED", chainId: NETWORK.chainId,
      sender: wallet.address, recipient: normalized.recipient, valueWei: normalized.valueWei, data: "0x", preferredGasWei: normalized.preferredGasWei,
      maxAuthorizedFeeWei: normalized.maxAuthorizedFeeWei, deadlineUtc: normalized.deadlineUtc, deadlineMs: normalized.deadlineMs, monitoringIntervalSec: normalized.monitoringIntervalSec,
      requestReceivedAt: iso(receivedAt), requestedAt: iso(acceptedAt), requestedAtMs: acceptedAt, initialGasPriceWei: observation.gasPriceWei,
      initialGasEstimate: gasLimit.toString(), baselineEstimatedFeeWei: baseline.toString(), reservedSpendWei: requestedReserve.toString(), reservationId: uid(), reservationConsumed: false,
      nextCheckMs: acceptedAt, scheduledAlarmAt: iso(acceptedAt), releaseReason: null, transactionHash: null, nonce: null, receipt: null, costComparison: null, broadcastAttempts: 0,
      timeline: [{ state: "QUEUED", at: iso(acceptedAt), reason: "REQUEST_ACCEPTED_AND_RECOVERY_ALARM_PERSISTED" }]
    };
    await this.storage.transaction(async txn => {
      const jobs = await txn.list({ prefix: JOB_PREFIX });
      if ([...jobs.values()].some(saved => ACTIVE.has(saved.state))) throw new Error("Only one outstanding job is supported; wait for terminal resolution before accepting another.");
      const rate = (await txn.get(RATE)) || { start: acceptedAt, count: 0 };
      if (acceptedAt - rate.start >= 3_600_000) { rate.start = acceptedAt; rate.count = 0; }
      if (rate.count >= 10) throw new Error("Owner queue rate limit reached (10 jobs/hour).");
      const ledger = (await txn.get(LEDGER)) || { reservedWei: "0", committedWei: "0" }, remaining = BigInt(config.maxTotalSpendWei) - BigInt(ledger.reservedWei) - BigInt(ledger.committedWei);
      if (requestedReserve > remaining) throw new Error("Aggregate spending ceiling would be exceeded.");
      rate.count += 1; ledger.reservedWei = (BigInt(ledger.reservedWei) + requestedReserve).toString();
      await txn.put(RATE, rate); await txn.put(LEDGER, ledger); await txn.put(JOB_PREFIX + job.id, job); await txn.setAlarm(acceptedAt);
    });
    return { job, observation };
  }

  async create(input) { const accepted = await this.accept(input); return { job: publicJob(await this.process(accepted.job.id, Date.now(), accepted.observation)) }; }

  async process(jobId, handlerWakeMs = Date.now(), providedGas = null) {
    const snapshot = await this.storage.get(JOB_PREFIX + jobId);
    if (!snapshot || TERMINAL.has(snapshot.state)) return snapshot;
    if (snapshot.state === "SUBMITTING") return this.recoverSubmission(jobId);
    if (["BROADCAST", "FEE_ACCOUNTING_PENDING", "UNRESOLVED"].includes(snapshot.state)) return this.confirm(jobId);
    if (["READY_FAVORABLE", "READY_DEADLINE"].includes(snapshot.state)) return this.submit(jobId);
    const gas = providedGas || await this.observeGas(false), decisionAt = Date.now();
    const stale = gas?.gasPriceWei != null && (!Number.isFinite(gas.observedAtMs) || decisionAt - gas.observedAtMs > 30_000);
    const decision = releaseDecision(snapshot, stale ? { ...gas, gasPriceWei: null } : gas, decisionAt);
    if (stale && !decision.release) decision.reason = "STALE_GAS_OBSERVATION";
    const result = await this.mutate(jobId, snapshot.revision, PRE_SUBMISSION, async (current, txn) => {
      current.actualHandlerWakeAt = iso(handlerWakeMs); current.decisionAt = iso(decisionAt);
      if (!decision.release) {
        const next = nextWake(current, decisionAt); move(current, "WAITING_FOR_GAS", decisionAt, decision.reason, { nextCheckMs: next, scheduledAlarmAt: iso(next) });
      } else if (!gas?.gasPriceWei || stale) {
        move(current, "DEADLINE_FAILURE", decisionAt, stale ? "STALE_FEE_DATA_AT_DEADLINE" : "FEE_DATA_UNAVAILABLE_AT_DEADLINE", { nextCheckMs: null, scheduledAlarmAt: null });
        await this.releaseLedger(txn, current);
      } else move(current, decision.state, decisionAt, decision.reason, { releaseReason: decision.reason, nextCheckMs: decisionAt, scheduledAlarmAt: iso(decisionAt) });
    });
    if (!result.ok || TERMINAL.has(result.job?.state)) return result.job;
    return ["READY_FAVORABLE", "READY_DEADLINE"].includes(result.job.state) ? this.submit(jobId) : result.job;
  }

  async submit(jobId) {
    const snapshot = await this.storage.get(JOB_PREFIX + jobId);
    if (!snapshot || !["READY_FAVORABLE", "READY_DEADLINE"].includes(snapshot.state)) return snapshot;
    const wallet = this.wallet(); let nonceRaw, gas;
    try { await this.verifyChain(); [nonceRaw, gas] = await Promise.all([rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionCount", [wallet.address, "pending"]), this.observeGas(true)]); }
    catch (error) { return this.failBeforeSigning(snapshot, error); }
    const now = Date.now(), nonce = quantity(nonceRaw, "eth_getTransactionCount"), gasLimit = BigInt(snapshot.initialGasEstimate), decision = releaseDecision(snapshot, gas, now);
    if (!decision.release) {
      const next = nextWake(snapshot, now); return (await this.mutate(jobId, snapshot.revision, new Set([snapshot.state]), async current => move(current, "WAITING_FOR_GAS", now, "GAS_CHANGED_BEFORE_SUBMISSION", { nextCheckMs: next, scheduledAlarmAt: iso(next), decisionAt: iso(now) }))).job;
    }
    const ledger = (await this.storage.get(LEDGER)) || { committedWei: "0" }, remaining = BigInt(this.env.MAX_TOTAL_SPEND_WEI) - BigInt(ledger.committedWei);
    const safety = safeToSubmit(snapshot, gas.gasPriceWei, gasLimit, { remainingSpendWei: remaining.toString() });
    if (!safety.ok) return this.failBeforeSigning(snapshot, new Error(safety.reason));
    this.wallet();
    const leaseId = uid();
    const reserved = await this.mutate(jobId, snapshot.revision, new Set([snapshot.state]), async current => move(current, "SUBMITTING", now, "NONCE_RESERVED", { phase: "NONCE_RESERVED", nonce: nonce.toString(), submissionGasPriceWei: gas.gasPriceWei, submissionLeaseId: leaseId, fence: (current.fence || 0) + 1, leaseExpiresAtMs: now + LEASE_MS, nextCheckMs: now + LEASE_MS, scheduledAlarmAt: iso(now + LEASE_MS) }));
    if (!reserved.ok) return reserved.job;
    const raw = await wallet.signTransaction({ type: 0, chainId: NETWORK.chainId, nonce, gasLimit, gasPrice: BigInt(gas.gasPriceWei), to: snapshot.recipient, value: BigInt(snapshot.valueWei), data: "0x" }), transaction = Transaction.from(raw);
    const signed = await this.mutate(jobId, reserved.job.revision, new Set(["SUBMITTING"]), async current => {
      if (current.submissionLeaseId !== leaseId || current.phase !== "NONCE_RESERVED") throw new Error("Submission fence changed before signing persisted.");
      current.phase = "SIGNED"; current.signedRawTransaction = raw; current.transactionHash = transaction.hash; current.nextCheckMs = Date.now() + LEASE_MS; current.scheduledAlarmAt = iso(current.nextCheckMs); current.timeline.push({ state: "SUBMITTING", at: iso(Date.now()), reason: "SIGNED_BYTES_PERSISTED" });
    });
    return signed.ok ? this.broadcastPrepared(jobId, signed.job.revision, leaseId) : signed.job;
  }

  async broadcastPrepared(jobId, expectedRevision, leaseId) {
    const attemptAt = Date.now();
    const marked = await this.mutate(jobId, expectedRevision, new Set(["SUBMITTING"]), async current => {
      if (current.submissionLeaseId !== leaseId || !["SIGNED", "BROADCASTING"].includes(current.phase) || !current.signedRawTransaction || !HASH.test(current.transactionHash)) throw new Error("Submission lease or signed identity is unavailable.");
      current.phase = "BROADCASTING"; current.broadcastAttempts = (current.broadcastAttempts || 0) + 1; current.broadcastAttemptAt = iso(attemptAt); current.submissionLatenessMs = Math.max(0, attemptAt - current.deadlineMs); current.leaseExpiresAtMs = attemptAt + LEASE_MS; current.nextCheckMs = attemptAt + LEASE_MS; current.scheduledAlarmAt = iso(current.nextCheckMs); current.timeline.push({ state: "SUBMITTING", at: iso(attemptAt), reason: "BROADCAST_ATTEMPT_STARTED" });
    });
    if (!marked.ok) return marked.job;
    let acknowledged, error;
    try { acknowledged = await rpc(this.env.ATLANTIC_RPC_URL, "eth_sendRawTransaction", [marked.job.signedRawTransaction]); } catch (caught) { error = caught; }
    const completedAt = Date.now();
    return (await this.mutate(jobId, marked.job.revision, new Set(["SUBMITTING"]), async current => {
      if (current.submissionLeaseId !== leaseId || current.transactionHash !== marked.job.transactionHash) return;
      if (!error && HASH.test(acknowledged) && sameHash(acknowledged, current.transactionHash)) move(current, "BROADCAST", completedAt, "RPC_ACKNOWLEDGED_EXPECTED_HASH", { phase: "ACKNOWLEDGED", rpcAcknowledgedAt: iso(completedAt), nextCheckMs: completedAt + RECEIPT_POLL_MS, scheduledAlarmAt: iso(completedAt + RECEIPT_POLL_MS), leaseExpiresAtMs: null });
      else { current.phase = "SIGNED"; current.lastSubmissionError = { at: iso(completedAt), message: error?.message || "RPC acknowledgement hash did not match the locally signed transaction.", code: error?.code ?? null, ambiguous: true }; current.leaseExpiresAtMs = completedAt; current.nextCheckMs = completedAt + RECEIPT_POLL_MS; current.scheduledAlarmAt = iso(current.nextCheckMs); }
    })).job;
  }

  async claimRecovery(snapshot) {
    const now = Date.now(), leaseId = uid();
    const result = await this.mutate(snapshot.id, snapshot.revision, new Set(["SUBMITTING"]), async current => {
      if (current.leaseExpiresAtMs && current.leaseExpiresAtMs > now) throw new Error("Submission lease remains active.");
      current.submissionLeaseId = leaseId; current.fence = (current.fence || 0) + 1; current.leaseExpiresAtMs = now + LEASE_MS; current.nextCheckMs = now + LEASE_MS; current.scheduledAlarmAt = iso(current.nextCheckMs); current.timeline.push({ state: "SUBMITTING", at: iso(now), reason: "RECOVERY_LEASE_ACQUIRED" });
    });
    return { ...result, leaseId };
  }

  async recoverSubmission(jobId) {
    let snapshot = await this.storage.get(JOB_PREFIX + jobId);
    if (!snapshot || snapshot.state !== "SUBMITTING") return snapshot;
    let claimed; try { claimed = await this.claimRecovery(snapshot); } catch { return snapshot; }
    if (!claimed.ok) return claimed.job; snapshot = claimed.job;
    if (snapshot.phase === "NONCE_RESERVED") {
      const wallet = this.wallet(), raw = await wallet.signTransaction({ type: 0, chainId: NETWORK.chainId, nonce: BigInt(snapshot.nonce), gasLimit: BigInt(snapshot.initialGasEstimate), gasPrice: BigInt(snapshot.submissionGasPriceWei), to: snapshot.recipient, value: BigInt(snapshot.valueWei), data: "0x" }), tx = Transaction.from(raw);
      const signed = await this.mutate(jobId, snapshot.revision, new Set(["SUBMITTING"]), async current => { if (current.submissionLeaseId !== claimed.leaseId) throw new Error("Recovery fence changed."); current.phase = "SIGNED"; current.signedRawTransaction = raw; current.transactionHash = tx.hash; });
      return signed.ok ? this.broadcastPrepared(jobId, signed.job.revision, claimed.leaseId) : signed.job;
    }
    let receipt = null, found = null;
    try { receipt = await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionReceipt", [snapshot.transactionHash], 5_000); } catch {}
    if (receipt) return this.confirmSnapshot(snapshot, receipt);
    try { found = await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionByHash", [snapshot.transactionHash], 5_000); } catch {}
    if (found && (!found.hash || sameHash(found.hash, snapshot.transactionHash))) {
      const now = Date.now(); return (await this.mutate(jobId, snapshot.revision, new Set(["SUBMITTING"]), async current => move(current, "BROADCAST", now, "EXPECTED_TRANSACTION_FOUND", { phase: "ACKNOWLEDGED", rpcAcknowledgedAt: iso(now), leaseExpiresAtMs: null, nextCheckMs: now + RECEIPT_POLL_MS, scheduledAlarmAt: iso(now + RECEIPT_POLL_MS) }))).job;
    }
    const age = Date.now() - Date.parse(snapshot.broadcastAttemptAt || snapshot.requestedAt);
    if (snapshot.broadcastAttempts < MAX_SEND_ATTEMPTS && age < STUCK_AFTER_MS) return this.broadcastPrepared(jobId, snapshot.revision, claimed.leaseId);
    const now = Date.now(); return (await this.mutate(jobId, snapshot.revision, new Set(["SUBMITTING"]), async current => move(current, "UNRESOLVED", now, "SIGNED_TRANSACTION_NOT_FOUND_AFTER_BOUNDED_RECONCILIATION", { phase: "UNRESOLVED", leaseExpiresAtMs: null, nextCheckMs: now + 300_000, scheduledAlarmAt: iso(now + 300_000) }))).job;
  }

  validateReceipt(job, receipt) {
    if (!receipt || !sameHash(receipt.transactionHash, job.transactionHash)) throw new Error("Receipt transaction hash does not match the signed transaction.");
    if (receipt.from && receipt.from.toLowerCase() !== job.sender.toLowerCase()) throw new Error("Receipt sender does not match the signed transaction.");
    if (receipt.to && receipt.to.toLowerCase() !== job.recipient.toLowerCase()) throw new Error("Receipt recipient does not match the signed transaction.");
    const status = quantity(receipt.status, "receipt.status"), blockNumber = quantity(receipt.blockNumber, "receipt.blockNumber"), gasUsed = quantity(receipt.gasUsed, "receipt.gasUsed");
    if (![0n, 1n].includes(status) || gasUsed <= 0n) throw new Error("Receipt status or gas usage is invalid.");
    return { status: status.toString(), blockNumber: blockNumber.toString(), gasUsed: gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice == null ? null : quantity(receipt.effectiveGasPrice, "receipt.effectiveGasPrice").toString(), transactionHash: receipt.transactionHash, from: receipt.from || null, to: receipt.to || null };
  }

  async confirm(jobId) {
    const snapshot = await this.storage.get(JOB_PREFIX + jobId);
    if (!snapshot || !["BROADCAST", "FEE_ACCOUNTING_PENDING", "UNRESOLVED"].includes(snapshot.state)) return snapshot;
    let receipt; try { receipt = await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionReceipt", [snapshot.transactionHash], 5_000); } catch (error) { return this.deferReceipt(snapshot, error.message); }
    if (!receipt) {
      const age = Date.now() - Date.parse(snapshot.broadcastAttemptAt || snapshot.requestedAt), now = Date.now(), stuck = age >= STUCK_AFTER_MS, delay = stuck ? 300_000 : RECEIPT_POLL_MS;
      return (await this.mutate(jobId, snapshot.revision, new Set([snapshot.state]), async current => move(current, stuck ? "UNRESOLVED" : snapshot.state, now, stuck ? "TRANSACTION_UNMINED_OR_DROPPED_NO_REPLACEMENT" : "RECEIPT_PENDING", { nextCheckMs: now + delay, scheduledAlarmAt: iso(now + delay) }))).job;
    }
    return this.confirmSnapshot(snapshot, receipt);
  }

  async confirmSnapshot(snapshot, receipt) {
    let parsed; try { parsed = this.validateReceipt(snapshot, receipt); } catch (error) { return this.deferReceipt(snapshot, error.message); }
    if (!parsed.effectiveGasPrice) {
      try { const tx = await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionByHash", [snapshot.transactionHash], 5_000); if (tx && (!tx.hash || sameHash(tx.hash, snapshot.transactionHash)) && tx.gasPrice != null) parsed.effectiveGasPrice = quantity(tx.gasPrice, "transaction.gasPrice").toString(); } catch {}
    }
    const now = Date.now();
    if (!parsed.effectiveGasPrice) return (await this.mutate(snapshot.id, snapshot.revision, new Set([snapshot.state]), async current => move(current, "FEE_ACCOUNTING_PENDING", now, "MINED_RECEIPT_FEE_DATA_PENDING", { receipt: parsed, receiptKnownAt: iso(now), feeAccountingPending: true, nextCheckMs: now + 60_000, scheduledAlarmAt: iso(now + 60_000), leaseExpiresAtMs: null }))).job;
    const gasPaid = BigInt(parsed.gasUsed) * BigInt(parsed.effectiveGasPrice), success = parsed.status === "1", actual = gasPaid + (success ? BigInt(snapshot.valueWei) : 0n);
    return this.finalize(snapshot, success ? "CONFIRMED" : "FAILED", success ? "RECEIPT_CONFIRMED" : "RECEIPT_STATUS_FAILED", actual, { receipt: parsed, confirmedAt: iso(now), costComparison: costComparison(snapshot, parsed), feeAccountingPending: false, explorerUrl: `${NETWORK.explorer}/tx/${snapshot.transactionHash}` });
  }

  async deferReceipt(snapshot, message) {
    const now = Date.now(); return (await this.mutate(snapshot.id, snapshot.revision, new Set([snapshot.state]), async current => { current.lastReceiptError = { at: iso(now), message }; current.nextCheckMs = now + RECEIPT_POLL_MS; current.scheduledAlarmAt = iso(current.nextCheckMs); })).job;
  }

  async releaseLedger(txn, job) {
    if (job.reservationConsumed) return;
    const ledger = (await txn.get(LEDGER)) || { reservedWei: "0", committedWei: "0" };
    ledger.reservedWei = (BigInt(ledger.reservedWei) - BigInt(job.reservedSpendWei)).toString(); job.reservationConsumed = true; job.committedSpendWei = null; await txn.put(LEDGER, ledger);
  }

  async finalize(snapshot, state, reason, actual, extra = {}) {
    const now = Date.now();
    return this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + snapshot.id);
      if (!current || current.revision !== snapshot.revision || TERMINAL.has(current.state) || current.reservationId !== snapshot.reservationId || current.reservationConsumed || !sameHash(current.transactionHash, snapshot.transactionHash)) return current;
      move(current, state, now, reason, { ...extra, nextCheckMs: null, scheduledAlarmAt: null, phase: state });
      const ledger = (await txn.get(LEDGER)) || { reservedWei: "0", committedWei: "0" };
      ledger.reservedWei = (BigInt(ledger.reservedWei) - BigInt(current.reservedSpendWei)).toString(); ledger.committedWei = (BigInt(ledger.committedWei) + actual).toString(); current.reservationConsumed = true; current.committedSpendWei = actual.toString(); current.revision += 1;
      await txn.put(LEDGER, ledger); await txn.put(JOB_PREFIX + current.id, current); await this.rescheduleTxn(txn); return current;
    });
  }

  async failBeforeSigning(snapshot, error) {
    const now = Date.now(), state = snapshot.releaseReason === "DEADLINE" ? "DEADLINE_FAILURE" : "FAILED";
    return this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + snapshot.id);
      if (!current || current.revision !== snapshot.revision || !PRE_SUBMISSION.has(current.state) || current.signedRawTransaction || current.nonce != null) return current;
      move(current, state, now, error.message.startsWith("RPC chain mismatch") ? "RPC_CHAIN_MISMATCH" : "SUBMISSION_PREPARATION_FAILED", { error: error.message, nextCheckMs: null, scheduledAlarmAt: null }); await this.releaseLedger(txn, current); current.revision += 1;
      await txn.put(JOB_PREFIX + current.id, current); await this.rescheduleTxn(txn); return current;
    });
  }

  async cancel(jobId) {
    const now = Date.now();
    const result = await this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + jobId); if (!current) throw new Error("Job not found.");
      if (!PRE_SUBMISSION.has(current.state) || current.signedRawTransaction || current.nonce != null) throw new Error("Job can no longer be cancelled; submission has won the atomic boundary.");
      move(current, "CANCELLED", now, "OWNER_CANCELLED", { nextCheckMs: null, scheduledAlarmAt: null, phase: "CANCELLED" }); await this.releaseLedger(txn, current); current.revision += 1;
      await txn.put(JOB_PREFIX + current.id, current); await this.rescheduleTxn(txn); return current;
    });
    return { job: publicJob(result) };
  }

  async schedule() { return this.storage.transaction(async txn => this.rescheduleTxn(txn)); }
  async alarm() { const jobs = await this.storage.list({ prefix: JOB_PREFIX }); for (const job of [...jobs.values()].filter(saved => ACTIVE.has(saved.state) && saved.nextCheckMs <= Date.now()).sort((a, b) => a.nextCheckMs - b.nextCheckMs)) await this.process(job.id, Date.now()); await this.schedule(); }
}
