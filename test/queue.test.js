import test from "node:test";
import assert from "node:assert/strict";
import { Transaction, Wallet } from "ethers";
import { GasQueue } from "../src/queue.js";

class Storage {
  constructor(seed) { this.m = new Map(seed); this.alarm = null; this.tail = Promise.resolve(); }
  async get(key) { await this.tail; return structuredClone(this.m.get(key)); }
  async put(key, value) { return this.exclusive(async draft => draft.set(key, structuredClone(value))); }
  async delete(key) { return this.exclusive(async draft => draft.delete(key)); }
  async list({ prefix } = {}) { await this.tail; return new Map([...this.m].filter(([key]) => !prefix || key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); }
  async setAlarm(value) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
  async exclusive(fn) {
    let release;
    const previous = this.tail;
    this.tail = new Promise(resolve => { release = resolve; });
    await previous;
    const draft = structuredClone(this.m);
    try { const result = await fn(draft); this.m = draft; return result; } finally { release(); }
  }
  async transaction(fn) {
    return this.exclusive(async draft => {
      const txn = {
        get: async key => structuredClone(draft.get(key)),
        put: async (key, value) => draft.set(key, structuredClone(value)),
        delete: async key => draft.delete(key),
        list: async ({ prefix } = {}) => new Map([...draft].filter(([key]) => !prefix || key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]))
      };
      return fn(txn);
    });
  }
}

const key = "0x0123456789012345678901234567890123456789012345678901234567890123";
const wallet = new Wallet(key);
const recipient = "0x1111111111111111111111111111111111111111";
const env = () => ({ ATLANTIC_RPC_URL: "https://rpc.test", DEMO_SIGNER_PRIVATE_KEY: key, DEMO_SIGNER_ADDRESS: wallet.address, ALLOWED_RECIPIENT: recipient, MAX_TRANSFER_WEI: "1000000000000000", MAX_TOTAL_SPEND_WEI: "10000000000000000" });
const body = (deadline = Date.now() + 60_000, preferred = "20", maximum = "0.001") => ({ chainId: 688689, recipient, valuePhRS: "0.0001", preferredGasGwei: preferred, maxAuthorizedFeePhRS: maximum, deadlineUtc: new Date(deadline).toISOString(), monitoringIntervalSec: 15 });
const createRequest = payload => new Request("https://queue/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

class RpcController {
  constructor({ gas = "0x2540be400", balance = "0xde0b6b3a7640000", chainId = "0xa8231", delay = {} } = {}) {
    this.gas = gas; this.balance = balance; this.chainId = chainId; this.delay = delay;
    this.pendingNonce = 0; this.sends = []; this.receipt = null; this.transactionFound = null; this.ambiguousOnce = false;
  }
  install() {
    global.fetch = async (_url, options) => {
      const { method, params } = JSON.parse(options.body);
      if (this.delay[method]) await new Promise(resolve => setTimeout(resolve, this.delay[method]));
      if (method === "eth_sendRawTransaction") {
        const raw = params[0];
        this.sends.push(raw);
        if (this.ambiguousOnce) { this.ambiguousOnce = false; throw new Error("timeout"); }
        const nonce = Number(Transaction.from(raw).nonce);
        this.pendingNonce = Math.max(this.pendingNonce, nonce + 1);
        return Response.json({ jsonrpc: "2.0", id: 1, result: Transaction.from(raw).hash });
      }
      const result = {
        eth_chainId: this.chainId,
        eth_gasPrice: this.gas,
        eth_blockNumber: "0x64",
        eth_estimateGas: "0x5208",
        eth_getBalance: this.balance,
        eth_getTransactionCount: `0x${this.pendingNonce.toString(16)}`,
        eth_getTransactionReceipt: this.receipt,
        eth_getTransactionByHash: this.transactionFound
      }[method];
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    };
    return this;
  }
  successReceipt(hash) { this.receipt = { status: "0x1", blockNumber: "0x65", gasUsed: "0x5208", effectiveGasPrice: this.gas, transactionHash: hash }; }
  forceDue(storage, id) { const job = storage.m.get("job:" + id); job.nextCheckMs = Date.now() - 1; storage.m.set("job:" + id, job); }
}

test("restart restores a waiting deadline and alarm", async () => {
  new RpcController({ gas: "0x4a817c800" }).install();
  const storage = new Storage();
  const first = new GasQueue({ storage }, env());
  const created = await (await first.fetch(createRequest(body(Date.now() + 60_000, "1")))).json();
  assert.equal(created.job.state, "WAITING_FOR_GAS");
  const restarted = new GasQueue({ storage }, env());
  assert.equal((await (await restarted.fetch(new Request("https://queue/jobs"))).json()).jobs.length, 1);
  assert.ok(storage.alarm);
});

test("confirmed state persists after reload and repeated alarms", async () => {
  const rpc = new RpcController().install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body()))).json();
  rpc.successReceipt(created.job.transactionHash);
  rpc.forceDue(storage, created.job.id);
  await queue.alarm();
  const restarted = new GasQueue({ storage }, env());
  await restarted.alarm();
  await restarted.alarm();
  const saved = await storage.get("job:" + created.job.id);
  assert.equal(saved.state, "CONFIRMED");
  assert.equal(saved.reservationConsumed, true);
  assert.equal(rpc.sends.length, 1);
});

test("concurrent receipt confirmation consumes one reservation exactly once", async () => {
  const rpc = new RpcController().install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body()))).json();
  rpc.successReceipt(created.job.transactionHash);
  await Promise.all([
    queue.confirm(created.job.id, Date.now()),
    queue.confirm(created.job.id, Date.now()),
    new GasQueue({ storage }, env()).confirm(created.job.id, Date.now())
  ]);
  const saved = await storage.get("job:" + created.job.id);
  const ledger = await storage.get("spend-ledger");
  assert.equal(saved.state, "CONFIRMED");
  assert.equal(saved.reservationConsumed, true);
  assert.equal(ledger.reservedWei, "0");
  assert.equal(ledger.committedWei, saved.committedSpendWei);
});

test("cancelled waiting job never broadcasts after later alarms", async () => {
  const rpc = new RpcController({ gas: "0x4a817c800" }).install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body(Date.now() + 60_000, "1")))).json();
  await queue.fetch(new Request(`https://queue/jobs/${created.job.id}/cancel`, { method: "POST" }));
  await queue.alarm();
  const restarted = new GasQueue({ storage }, env());
  await restarted.alarm();
  assert.equal((await storage.get("job:" + created.job.id)).state, "CANCELLED");
  assert.equal(rpc.sends.length, 0);
});

test("deadline safety failure remains terminal", async () => {
  const rpc = new RpcController({ gas: "0x4a817c800" }).install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body(Date.now() + 60_000, "1")))).json();
  const job = storage.m.get("job:" + created.job.id);
  job.deadlineMs = Date.now() - 1;
  storage.m.set("job:" + job.id, job);
  await queue.process(job.id, Date.now(), { gasPriceWei: "100000000000", observedAtMs: Date.now() });
  await queue.alarm();
  assert.equal((await storage.get("job:" + job.id)).state, "DEADLINE_FAILURE");
  assert.equal(rpc.sends.length, 0);
});

test("concurrent delayed create/run/alarm cannot conflict on nonces", async () => {
  const rpc = new RpcController({ delay: { eth_getTransactionCount: 40, eth_sendRawTransaction: 40 } }).install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const [a, b] = await Promise.all([
    queue.fetch(createRequest(body(Date.now() + 90_000))),
    queue.fetch(createRequest(body(Date.now() + 90_000)))
  ]);
  const first = (await a.json()).job;
  const second = (await b.json()).job;
  await Promise.all([queue.process(first.id, Date.now()), queue.process(second.id, Date.now()), queue.alarm()]);
  assert.equal(new Set(rpc.sends.map(raw => Transaction.from(raw).hash)).size, 1);
  assert.deepEqual([...new Set(rpc.sends.map(raw => Number(Transaction.from(raw).nonce)))], [0]);
  const broadcast = [first, second].map(x => storage.m.get("job:" + x.id)).find(x => x.transactionHash);
  rpc.successReceipt(broadcast.transactionHash);
  rpc.forceDue(storage, broadcast.id);
  await queue.alarm();
  const waiting = [first, second].map(x => storage.m.get("job:" + x.id)).find(x => x.id !== broadcast.id);
  rpc.forceDue(storage, waiting.id);
  await queue.alarm();
  assert.deepEqual([...new Set(rpc.sends.map(raw => Number(Transaction.from(raw).nonce)))].sort(), [0, 1]);
});

test("ambiguous submission reconciles identical signed bytes", async () => {
  const rpc = new RpcController().install();
  rpc.ambiguousOnce = true;
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body()))).json();
  const raw = storage.m.get("job:" + created.job.id).signedRawTransaction;
  const job = storage.m.get("job:" + created.job.id);
  job.nextCheckMs = Date.now() - 1;
  job.submissionLeaseId = job.submissionLeaseId || storage.m.get("signer-submission-lock").leaseId;
  storage.m.set("job:" + job.id, job);
  const lock = storage.m.get("signer-submission-lock"); lock.leaseExpiresAtMs = Date.now() - 1; storage.m.set("signer-submission-lock", lock);
  await queue.alarm();
  assert.equal(storage.m.get("job:" + job.id).signedRawTransaction, raw);
  assert.equal(new Set(rpc.sends).size, 1);
});

test("missing receipt fee retains conservative reservation and never rebroadcasts", async () => {
  const rpc = new RpcController().install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body()))).json();
  rpc.receipt = { status: "0x1", blockNumber: "0x65", gasUsed: "0x5208", transactionHash: created.job.transactionHash };
  rpc.forceDue(storage, created.job.id);
  await queue.alarm();
  const saved = await storage.get("job:" + created.job.id);
  const ledger = await storage.get("spend-ledger");
  assert.equal(saved.state, "BROADCAST");
  assert.equal(saved.feeAccountingPending, true);
  assert.equal(saved.reservationConsumed, false);
  assert.equal(ledger.reservedWei, saved.reservedSpendWei);
  assert.equal(ledger.committedWei, "0");
  rpc.forceDue(storage, saved.id);
  await queue.alarm();
  assert.equal(rpc.sends.length, 1);
});

test("wrong RPC chain rejects before signing or broadcast", async () => {
  const rpc = new RpcController({ chainId: "0x1" }).install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const response = await queue.fetch(createRequest(body()));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /RPC chain mismatch/);
  assert.equal((await storage.list({ prefix: "job:" })).size, 0);
  assert.equal(rpc.sends.length, 0);
});

test("RPC chain change after acceptance rejects before signing or broadcast", async () => {
  const rpc = new RpcController({ gas: "0x4a817c800" }).install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body(Date.now() + 60_000, "1")))).json();
  rpc.chainId = "0x1";
  const job = storage.m.get("job:" + created.job.id);
  job.deadlineMs = Date.now() - 1;
  storage.m.set("job:" + job.id, job);
  await queue.process(job.id, Date.now(), { gasPriceWei: "1", observedAtMs: Date.now() });
  const saved = await storage.get("job:" + job.id);
  assert.equal(saved.state, "DEADLINE_FAILURE");
  assert.equal(saved.timeline.at(-1).reason, "RPC_CHAIN_MISMATCH");
  assert.equal(rpc.sends.length, 0);
});

test("insufficient signer funding rejects before persistence", async () => {
  new RpcController({ balance: "0x1" }).install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const response = await queue.fetch(createRequest(body()));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /funding is insufficient/);
  assert.equal((await storage.list({ prefix: "job:" })).size, 0);
});

test("failed receipt persists terminal failure and actual gas accounting", async () => {
  const rpc = new RpcController().install();
  const storage = new Storage();
  const queue = new GasQueue({ storage }, env());
  const created = await (await queue.fetch(createRequest(body()))).json();
  rpc.receipt = { status: "0x0", blockNumber: "0x65", gasUsed: "0x5208", effectiveGasPrice: rpc.gas, transactionHash: created.job.transactionHash };
  rpc.forceDue(storage, created.job.id);
  await queue.alarm();
  await new GasQueue({ storage }, env()).alarm();
  const saved = await storage.get("job:" + created.job.id);
  assert.equal(saved.state, "FAILED");
  assert.equal(saved.timeline.at(-1).reason, "RECEIPT_STATUS_FAILED");
  assert.equal(saved.committedSpendWei, (21_000n * BigInt(rpc.gas)).toString());
});
