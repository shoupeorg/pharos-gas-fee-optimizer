import { Transaction, Wallet } from "ethers";
import { canCancel, costComparison, nextWake, releaseDecision, safeToSubmit, validateJob } from "./engine.js";
import { bigint, hex, rpc } from "./rpc.js";
import { ENGINE_VERSION, NETWORK, TERMINAL } from "./constants.js";

const JOB_PREFIX = "job:";
const HISTORY = "gas-history";
const LEDGER = "spend-ledger";
const RATE = "rate-window";
const SIGNER_LOCK = "signer-submission-lock";
const LOCK_LEASE_MS = 30_000;
const nowIso = value => new Date(value).toISOString();
const newId = () => crypto.randomUUID();

function publicJob(job) {
  if (!job) return null;
  const { signedRawTransaction, submissionLeaseId, ...safe } = job;
  return safe;
}

function transition(job, state, now, reason, extra = {}) {
  job.state = state;
  job.timeline.push({ state, at: nowIso(now), reason });
  Object.assign(job, extra);
  return job;
}

export class GasQueue {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
  }

  config() {
    return { allowedRecipient: this.env.ALLOWED_RECIPIENT, maxTransferWei: this.env.MAX_TRANSFER_WEI, maxTotalSpendWei: this.env.MAX_TOTAL_SPEND_WEI };
  }

  async fetch(req) {
    try {
      const url = new URL(req.url);
      if (url.pathname === "/jobs" && req.method === "GET") return this.json({ jobs: await this.listJobs() });
      if (url.pathname === "/history" && req.method === "GET") return this.json({ observations: (await this.storage.get(HISTORY)) || [] });
      if (url.pathname === "/jobs" && req.method === "POST") return this.json(await this.create(await req.json()), 201);
      const match = url.pathname.match(/^\/jobs\/([^/]+)(?:\/(cancel|run))?$/);
      if (match) {
        const job = await this.storage.get(JOB_PREFIX + match[1]);
        if (!job) return this.json({ error: "Job not found." }, 404);
        if (req.method === "GET") return this.json({ job: publicJob(job) });
        if (req.method === "POST" && match[2] === "cancel") return this.json(await this.cancel(job.id));
        if (req.method === "POST" && match[2] === "run") return this.json({ job: publicJob(await this.process(job.id, Date.now())) });
      }
      return this.json({ error: "Not found." }, 404);
    } catch (error) { return this.json({ error: error.message }, error.status || 400); }
  }

  json(data, status = 200) { return Response.json(data, { status }); }

  async listJobs() {
    const map = await this.storage.list({ prefix: JOB_PREFIX });
    return [...map.values()].map(publicJob).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  async verifyChain() {
    const observed = bigint(await rpc(this.env.ATLANTIC_RPC_URL, "eth_chainId"));
    if (observed !== BigInt(NETWORK.chainId)) throw new Error(`RPC chain mismatch: expected ${NETWORK.chainId}, received ${observed}.`);
    return observed;
  }

  async recordObservation(observation) {
    await this.storage.transaction(async txn => {
      const history = (await txn.get(HISTORY)) || [];
      history.push(observation);
      await txn.put(HISTORY, history.slice(-200));
    });
  }

  async observeGas(now, required = false) {
    try {
      const [price, block] = await Promise.all([rpc(this.env.ATLANTIC_RPC_URL, "eth_gasPrice"), rpc(this.env.ATLANTIC_RPC_URL, "eth_blockNumber")]);
      const observation = { observedAt: nowIso(now), observedAtMs: now, chainId: NETWORK.chainId, blockNumber: bigint(block).toString(), gasPriceWei: bigint(price).toString(), source: "Pharos Atlantic JSON-RPC", error: null };
      await this.recordObservation(observation);
      return observation;
    } catch (error) {
      const observation = { observedAt: nowIso(now), observedAtMs: now, chainId: NETWORK.chainId, blockNumber: null, gasPriceWei: null, source: "Pharos Atlantic JSON-RPC", error: { message: error.message, code: error.code ?? null } };
      await this.recordObservation(observation);
      if (required) throw error;
      return observation;
    }
  }

  async create(input) {
    const now = Date.now();
    const config = this.config();
    if (!this.env.DEMO_SIGNER_PRIVATE_KEY || !this.env.DEMO_SIGNER_ADDRESS) throw new Error("Owner demo signer is not configured; public inspection remains available.");
    const wallet = new Wallet(this.env.DEMO_SIGNER_PRIVATE_KEY);
    if (wallet.address.toLowerCase() !== this.env.DEMO_SIGNER_ADDRESS.toLowerCase()) throw new Error("Configured signer address does not match the secret key.");
    const normalized = validateJob(input, now, config);
    await this.verifyChain();
    const observation = await this.observeGas(now, true);
    const transaction = { from: wallet.address, to: normalized.recipient, value: hex(normalized.valueWei), data: "0x" };
    const [estimateHex, balanceHex] = await Promise.all([rpc(this.env.ATLANTIC_RPC_URL, "eth_estimateGas", [transaction]), rpc(this.env.ATLANTIC_RPC_URL, "eth_getBalance", [wallet.address, "latest"])]);
    const gasLimit = bigint(estimateHex);
    const baseline = gasLimit * BigInt(observation.gasPriceWei);
    const value = BigInt(normalized.valueWei);
    const balance = bigint(balanceHex);
    if (balance < value + BigInt(normalized.maxAuthorizedFeeWei)) throw new Error("Demo signer funding is insufficient for value plus the authorized maximum fee.");
    if (baseline > BigInt(normalized.maxAuthorizedFeeWei)) throw new Error("Initial estimated fee exceeds the job's maximum authorized fee.");
    const requestedReserve = value + BigInt(normalized.maxAuthorizedFeeWei);
    const job = {
      id: newId(), engineVersion: ENGINE_VERSION, state: "QUEUED", chainId: NETWORK.chainId,
      sender: wallet.address, recipient: normalized.recipient, valueWei: normalized.valueWei, data: "0x",
      preferredGasWei: normalized.preferredGasWei, maxAuthorizedFeeWei: normalized.maxAuthorizedFeeWei,
      deadlineUtc: normalized.deadlineUtc, deadlineMs: normalized.deadlineMs, monitoringIntervalSec: normalized.monitoringIntervalSec,
      requestedAt: nowIso(now), requestedAtMs: now, initialGasPriceWei: observation.gasPriceWei,
      initialGasEstimate: gasLimit.toString(), baselineEstimatedFeeWei: baseline.toString(), reservedSpendWei: requestedReserve.toString(),
      reservationId: newId(), reservationConsumed: false, nextCheckMs: now, scheduledAlarmAt: null, releaseReason: null,
      transactionHash: null, nonce: null, receipt: null, costComparison: null, deadlineLatenessMs: null,
      timeline: [{ state: "QUEUED", at: nowIso(now), reason: "REQUEST_ACCEPTED" }]
    };
    await this.storage.transaction(async txn => {
      const rate = (await txn.get(RATE)) || { start: now, count: 0 };
      if (now - rate.start >= 3_600_000) { rate.start = now; rate.count = 0; }
      if (rate.count >= 10) throw new Error("Owner queue rate limit reached (10 jobs/hour).");
      const ledger = (await txn.get(LEDGER)) || { reservedWei: "0", committedWei: "0", unresolvedWei: "0" };
      const remaining = BigInt(config.maxTotalSpendWei) - BigInt(ledger.reservedWei) - BigInt(ledger.committedWei) - BigInt(ledger.unresolvedWei || "0");
      if (requestedReserve > remaining) throw new Error("Aggregate spending ceiling would be exceeded.");
      rate.count += 1;
      ledger.reservedWei = (BigInt(ledger.reservedWei) + requestedReserve).toString();
      await txn.put(RATE, rate);
      await txn.put(LEDGER, ledger);
      await txn.put(JOB_PREFIX + job.id, job);
    });
    const processed = await this.process(job.id, now, observation);
    await this.schedule();
    return { job: publicJob(processed) };
  }

  async process(jobId, now = Date.now(), providedGas = null) {
    let job = await this.storage.get(JOB_PREFIX + jobId);
    if (!job || TERMINAL.has(job.state)) return job;
    if (job.state === "SUBMITTING") return this.reconcile(job.id, now);
    if (job.state === "BROADCAST") return this.confirm(job.id, now);
    let gas = providedGas;
    if (!gas) {
      const history = (await this.storage.get(HISTORY)) || [];
      const last = history.at(-1);
      gas = now >= job.deadlineMs && last?.gasPriceWei && now - last.observedAtMs <= 120_000 ? last : await this.observeGas(now, false);
    }
    job = await this.storage.get(JOB_PREFIX + jobId);
    if (!job || TERMINAL.has(job.state)) return job;
    const decision = releaseDecision(job, gas, now);
    job.decisionAt = nowIso(now);
    if (!decision.release) {
      transition(job, "WAITING_FOR_GAS", now, decision.reason, { nextCheckMs: nextWake(job, now) });
      await this.persistIfActive(job);
      await this.schedule();
      return (await this.storage.get(JOB_PREFIX + job.id)) || job;
    }
    transition(job, decision.state, now, decision.reason, { releaseReason: decision.reason, deadlineLatenessMs: Math.max(0, now - job.deadlineMs) });
    await this.persistIfActive(job);
    if (!gas?.gasPriceWei) {
      transition(job, "DEADLINE_FAILURE", now, "FEE_DATA_UNAVAILABLE_AT_DEADLINE");
      return this.releaseReserve(job);
    }
    return this.submit(job.id, gas, now);
  }

  async persistIfActive(job) {
    await this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + job.id);
      if (!current || TERMINAL.has(current.state)) return;
      await txn.put(JOB_PREFIX + job.id, { ...current, ...job });
    });
  }

  async acquireSubmissionLock(jobId, now) {
    return this.storage.transaction(async txn => {
      const job = await txn.get(JOB_PREFIX + jobId);
      if (!job || TERMINAL.has(job.state)) return { acquired: false, terminal: true };
      const lock = await txn.get(SIGNER_LOCK);
      if (lock) {
        const active = await txn.get(JOB_PREFIX + lock.activeJobId);
        if (!active || TERMINAL.has(active.state)) await txn.delete(SIGNER_LOCK);
        else if (lock.activeJobId !== jobId) return { acquired: false, busy: true, activeJobId: lock.activeJobId, retryAt: Math.max(now + 5_000, active.nextCheckMs || 0) };
        else if (now < lock.leaseExpiresAtMs) return { acquired: false, ownedInFlight: true, retryAt: lock.leaseExpiresAtMs };
        else {
          const recovered = { ...lock, leaseId: newId(), leaseExpiresAtMs: now + LOCK_LEASE_MS, recoveredAt: nowIso(now) };
          await txn.put(SIGNER_LOCK, recovered);
          return { acquired: true, recovered: true, lock: recovered, job };
        }
      }
      const created = { activeJobId: jobId, leaseId: newId(), phase: "ALLOCATING", acquiredAt: nowIso(now), leaseExpiresAtMs: now + LOCK_LEASE_MS, nonce: null };
      await txn.put(SIGNER_LOCK, created);
      return { acquired: true, recovered: false, lock: created, job };
    });
  }

  async deferForLock(jobId, now, result) {
    await this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + jobId);
      if (!current || TERMINAL.has(current.state) || current.state === "SUBMITTING" || current.state === "BROADCAST") return;
      current.nextCheckMs = result.retryAt || now + 5_000;
      current.timeline.push({ state: current.state, at: nowIso(now), reason: result.busy ? "SIGNER_LOCK_BUSY" : "SUBMISSION_ALREADY_IN_FLIGHT" });
      await txn.put(JOB_PREFIX + jobId, current);
    });
    await this.schedule();
    return this.storage.get(JOB_PREFIX + jobId);
  }

  async submit(jobId, gas, now) {
    const claim = await this.acquireSubmissionLock(jobId, now);
    if (!claim.acquired) return claim.terminal ? this.storage.get(JOB_PREFIX + jobId) : this.deferForLock(jobId, now, claim);
    try {
      await this.verifyChain();
      let job = await this.storage.get(JOB_PREFIX + jobId);
      if (!job || TERMINAL.has(job.state)) { await this.releaseSignerLock(jobId); return job; }
      const wallet = new Wallet(this.env.DEMO_SIGNER_PRIVATE_KEY);
      let nonce = job.nonce == null ? null : BigInt(job.nonce);
      if (nonce == null) nonce = bigint(await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionCount", [wallet.address, "pending"]));
      const gasLimit = BigInt(job.initialGasEstimate);
      const ledger = (await this.storage.get(LEDGER)) || { reservedWei: "0", committedWei: "0", unresolvedWei: "0" };
      const remaining = BigInt(this.env.MAX_TOTAL_SPEND_WEI) - BigInt(ledger.committedWei) - BigInt(ledger.unresolvedWei || "0");
      const safety = safeToSubmit(job, gas.gasPriceWei, gasLimit, { remainingSpendWei: remaining.toString() });
      if (!safety.ok) {
        transition(job, job.releaseReason === "DEADLINE" ? "DEADLINE_FAILURE" : "FAILED", now, safety.reason);
        return this.releaseReserve(job);
      }
      const reserved = await this.storage.transaction(async txn => {
        const current = await txn.get(JOB_PREFIX + jobId);
        const lock = await txn.get(SIGNER_LOCK);
        if (!current || TERMINAL.has(current.state) || !lock || lock.activeJobId !== jobId || lock.leaseId !== claim.lock.leaseId) return null;
        current.nonce = nonce.toString();
        current.submissionGasPriceWei = gas.gasPriceWei;
        current.submissionLeaseId = lock.leaseId;
        lock.phase = "NONCE_RESERVED";
        lock.nonce = nonce.toString();
        lock.leaseExpiresAtMs = Date.now() + LOCK_LEASE_MS;
        await txn.put(JOB_PREFIX + jobId, current);
        await txn.put(SIGNER_LOCK, lock);
        return { job: current, lock };
      });
      if (!reserved) return this.storage.get(JOB_PREFIX + jobId);
      job = reserved.job;
      const raw = job.signedRawTransaction || await wallet.signTransaction({ type: 0, chainId: NETWORK.chainId, nonce, gasLimit, gasPrice: BigInt(job.submissionGasPriceWei), to: job.recipient, value: BigInt(job.valueWei), data: "0x" });
      const tx = Transaction.from(raw);
      const prepared = await this.storage.transaction(async txn => {
        const current = await txn.get(JOB_PREFIX + jobId);
        const lock = await txn.get(SIGNER_LOCK);
        if (!current || TERMINAL.has(current.state) || !lock || lock.activeJobId !== jobId || lock.leaseId !== reserved.lock.leaseId) return null;
        transition(current, "SUBMITTING", now, "SIGNED_RESTRICTED_NATIVE_TRANSFER", { nonce: nonce.toString(), transactionHash: tx.hash, signedRawTransaction: raw, broadcastAttemptAt: nowIso(now), actualGasPriceSubmittedWei: job.submissionGasPriceWei, nextCheckMs: now + 10_000 });
        lock.phase = "SIGNED";
        lock.transactionHash = tx.hash;
        lock.leaseExpiresAtMs = now + LOCK_LEASE_MS;
        await txn.put(JOB_PREFIX + jobId, current);
        await txn.put(SIGNER_LOCK, lock);
        return current;
      });
      if (!prepared) return this.storage.get(JOB_PREFIX + jobId);
      return this.broadcastPrepared(prepared, now);
    } catch (error) {
      const job = await this.storage.get(JOB_PREFIX + jobId);
      if (job?.signedRawTransaction) {
        job.lastSubmissionError = { at: nowIso(Date.now()), message: error.message, code: error.code ?? null, ambiguous: true };
        job.nextCheckMs = Date.now() + 10_000;
        await this.storage.put(JOB_PREFIX + job.id, job);
        await this.schedule();
        return job;
      }
      if (job && !TERMINAL.has(job.state)) {
        transition(job, job.releaseReason === "DEADLINE" ? "DEADLINE_FAILURE" : "FAILED", Date.now(), error.message.startsWith("RPC chain mismatch") ? "RPC_CHAIN_MISMATCH" : "SUBMISSION_PREPARATION_FAILED", { error: error.message });
        return this.releaseReserve(job);
      }
      await this.releaseSignerLock(jobId);
      return job;
    }
  }

  async broadcastPrepared(job, now) {
    try {
      const acknowledged = await rpc(this.env.ATLANTIC_RPC_URL, "eth_sendRawTransaction", [job.signedRawTransaction]);
      transition(job, "BROADCAST", Date.now(), "RPC_ACKNOWLEDGED", { transactionHash: acknowledged, rpcAcknowledgedAt: nowIso(Date.now()), nextCheckMs: Date.now() + 10_000 });
      await this.storage.put(JOB_PREFIX + job.id, job);
    } catch (error) {
      job.lastSubmissionError = { at: nowIso(Date.now()), message: error.message, code: error.code ?? null, ambiguous: true };
      job.nextCheckMs = Date.now() + 10_000;
      await this.storage.put(JOB_PREFIX + job.id, job);
    }
    await this.schedule();
    return job;
  }

  async ensureLockForUnresolved(job, now) {
    return this.storage.transaction(async txn => {
      const lock = await txn.get(SIGNER_LOCK);
      if (lock?.activeJobId === job.id) return lock;
      if (lock) return null;
      const restored = { activeJobId: job.id, leaseId: job.submissionLeaseId || newId(), phase: job.signedRawTransaction ? "SIGNED" : "NONCE_RESERVED", acquiredAt: nowIso(now), leaseExpiresAtMs: now + LOCK_LEASE_MS, nonce: job.nonce, transactionHash: job.transactionHash };
      await txn.put(SIGNER_LOCK, restored);
      return restored;
    });
  }

  async reconcile(jobId, now) {
    let job = await this.storage.get(JOB_PREFIX + jobId);
    if (!job || TERMINAL.has(job.state)) return job;
    const lock = await this.ensureLockForUnresolved(job, now);
    if (!lock) { job.nextCheckMs = now + 5_000; await this.storage.put(JOB_PREFIX + job.id, job); await this.schedule(); return job; }
    try {
      const receipt = await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionReceipt", [job.transactionHash], 4_000);
      if (receipt) {
        transition(job, "BROADCAST", now, "AMBIGUOUS_BROADCAST_RECEIPT_FOUND", { nextCheckMs: now });
        await this.storage.put(JOB_PREFIX + job.id, job);
        return this.confirm(job.id, now, receipt);
      }
    } catch {}
    try {
      const found = await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionByHash", [job.transactionHash], 4_000);
      if (found) {
        transition(job, "BROADCAST", now, "AMBIGUOUS_BROADCAST_RECONCILED", { rpcAcknowledgedAt: nowIso(now), nextCheckMs: now + 10_000 });
        await this.storage.put(JOB_PREFIX + job.id, job);
        await this.schedule();
        return job;
      }
    } catch {}
    return this.broadcastPrepared(job, now);
  }

  async confirm(jobId, now, knownReceipt = null) {
    let job = await this.storage.get(JOB_PREFIX + jobId);
    if (!job || TERMINAL.has(job.state)) return job;
    let receipt = knownReceipt;
    if (!receipt) {
      try { receipt = await rpc(this.env.ATLANTIC_RPC_URL, "eth_getTransactionReceipt", [job.transactionHash], 5_000); }
      catch { job.nextCheckMs = now + 10_000; await this.storage.put(JOB_PREFIX + job.id, job); await this.schedule(); return job; }
    }
    const status = bigint(receipt.status);
    const parsed = { status: status.toString(), blockNumber: bigint(receipt.blockNumber).toString(), gasUsed: bigint(receipt.gasUsed).toString(), effectiveGasPrice: receipt.effectiveGasPrice ? bigint(receipt.effectiveGasPrice).toString() : null, transactionHash: receipt.transactionHash || job.transactionHash };
    if (!parsed.effectiveGasPrice) {
      transition(job, "BROADCAST", now, "RECEIPT_FEE_DATA_PENDING", { receipt: parsed, receiptKnownAt: nowIso(now), feeAccountingPending: true, nextCheckMs: now + 15_000 });
      await this.persistReceiptPending(job);
      await this.schedule();
      return job;
    }
    const gasPaid = BigInt(parsed.gasUsed) * BigInt(parsed.effectiveGasPrice);
    const comparison = costComparison(job, parsed);
    if (status !== 1n) {
      transition(job, "FAILED", now, "RECEIPT_STATUS_FAILED", { receipt: parsed, confirmedAt: nowIso(now), costComparison: comparison, feeAccountingPending: false });
      return this.commitReserve(job, gasPaid);
    }
    const actual = gasPaid + BigInt(job.valueWei);
    transition(job, "CONFIRMED", now, "RECEIPT_CONFIRMED", { receipt: parsed, confirmedAt: nowIso(now), costComparison: comparison, feeAccountingPending: false, explorerUrl: `${NETWORK.explorer}/tx/${job.transactionHash}` });
    return this.commitReserve(job, actual);
  }

  async persistReceiptPending(job) {
    await this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + job.id);
      if (!current || TERMINAL.has(current.state)) return;
      const updated = { ...current, ...job, reservationConsumed: false };
      const lock = await txn.get(SIGNER_LOCK);
      if (lock?.activeJobId === job.id) await txn.delete(SIGNER_LOCK);
      await txn.put(JOB_PREFIX + job.id, updated);
    });
  }

  async cancel(jobId) {
    const result = await this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + jobId);
      if (!current) throw new Error("Job not found.");
      if (!canCancel(current)) throw new Error("Job can no longer be cancelled.");
      transition(current, "CANCELLED", Date.now(), "OWNER_CANCELLED");
      const ledger = (await txn.get(LEDGER)) || { reservedWei: "0", committedWei: "0", unresolvedWei: "0" };
      if (!current.reservationConsumed) {
        ledger.reservedWei = (BigInt(ledger.reservedWei) - BigInt(current.reservedSpendWei)).toString();
        current.reservationConsumed = true;
      }
      const lock = await txn.get(SIGNER_LOCK);
      if (lock?.activeJobId === jobId) await txn.delete(SIGNER_LOCK);
      await txn.put(LEDGER, ledger);
      await txn.put(JOB_PREFIX + jobId, current);
      return current;
    });
    await this.schedule();
    return { job: publicJob(result) };
  }

  async releaseReserve(job) {
    const updated = await this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + job.id);
      if (!current) return job;
      if (current.reservationConsumed || (current.reservationId && current.reservationId !== job.reservationId)) return current;
      const merged = { ...current, ...job, reservationId: current.reservationId, reservationConsumed: true };
      const ledger = (await txn.get(LEDGER)) || { reservedWei: "0", committedWei: "0", unresolvedWei: "0" };
      ledger.reservedWei = (BigInt(ledger.reservedWei) - BigInt(current.reservedSpendWei)).toString();
      const lock = await txn.get(SIGNER_LOCK);
      if (lock?.activeJobId === job.id) await txn.delete(SIGNER_LOCK);
      await txn.put(LEDGER, ledger);
      await txn.put(JOB_PREFIX + job.id, merged);
      return merged;
    });
    Object.assign(job, updated);
    await this.schedule();
    return job;
  }

  async commitReserve(job, actual) {
    const updated = await this.storage.transaction(async txn => {
      const current = await txn.get(JOB_PREFIX + job.id);
      if (!current) return job;
      if (current.reservationConsumed || (current.reservationId && current.reservationId !== job.reservationId)) return current;
      const merged = { ...current, ...job, reservationId: current.reservationId, reservationConsumed: true, committedSpendWei: actual.toString() };
      const ledger = (await txn.get(LEDGER)) || { reservedWei: "0", committedWei: "0", unresolvedWei: "0" };
      ledger.reservedWei = (BigInt(ledger.reservedWei) - BigInt(current.reservedSpendWei)).toString();
      ledger.committedWei = (BigInt(ledger.committedWei) + actual).toString();
      const lock = await txn.get(SIGNER_LOCK);
      if (lock?.activeJobId === job.id) await txn.delete(SIGNER_LOCK);
      await txn.put(LEDGER, ledger);
      await txn.put(JOB_PREFIX + job.id, merged);
      return merged;
    });
    Object.assign(job, updated);
    await this.schedule();
    return job;
  }

  async releaseSignerLock(jobId) {
    await this.storage.transaction(async txn => {
      const lock = await txn.get(SIGNER_LOCK);
      if (lock?.activeJobId === jobId) await txn.delete(SIGNER_LOCK);
    });
  }

  async schedule() {
    const jobs = await this.listJobs();
    const next = jobs.filter(job => !TERMINAL.has(job.state) && job.nextCheckMs).sort((a, b) => a.nextCheckMs - b.nextCheckMs)[0];
    if (next) {
      await this.storage.setAlarm(next.nextCheckMs);
      await this.storage.transaction(async txn => {
        const raw = await txn.get(JOB_PREFIX + next.id);
        if (raw && !TERMINAL.has(raw.state)) { raw.scheduledAlarmAt = nowIso(next.nextCheckMs); await txn.put(JOB_PREFIX + next.id, raw); }
      });
    } else await this.storage.deleteAlarm();
  }

  async alarm() {
    const now = Date.now();
    const jobs = await this.listJobs();
    await Promise.all(jobs.filter(job => !TERMINAL.has(job.state) && job.nextCheckMs <= now).map(job => this.process(job.id, now)));
    await this.schedule();
  }
}
