import { mkdir, writeFile } from "node:fs/promises";

const base = "https://pharos-gas-fee-optimizer.shoupeorg.workers.dev";
const rpc = "https://atlantic.dplabs-internal.com";
const signer = "0xF825689D4D6c5C2C306353E3A0905cB84bA234e0";
const examples = {
  favorable: "6f769894-fe9b-4a72-80e8-78d42913bdd0",
  deadline: "94c39eb1-bae3-4c81-bc99-47bdbb55a7bf",
};

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

async function rpcCall(method, params) {
  const response = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const result = await response.json();
  if (result.error) throw new Error(`${method} failed: ${JSON.stringify(result.error)}`);
  return result.result;
}

const capturedAt = new Date().toISOString();
const chainId = Number(BigInt(await rpcCall("eth_chainId", [])));
if (chainId !== 688689) throw new Error(`Wrong RPC chain: ${chainId}`);
const balanceWei = BigInt(await rpcCall("eth_getBalance", [signer, "latest"])).toString();
const history = await getJson(`${base}/api/gas-history`);
const manifest = { schemaVersion: "authorized-demonstrations/1.0.0", capturedAt, chainId, signer, examples: {} };

await mkdir("evidence", { recursive: true });
await mkdir("public/evidence", { recursive: true });

for (const [name, id] of Object.entries(examples)) {
  const { job } = await getJson(`${base}/api/jobs/${id}`);
  if (job.state !== "CONFIRMED" || !job.transactionHash) throw new Error(`${name} is not receipt-confirmed`);
  const receipt = await rpcCall("eth_getTransactionReceipt", [job.transactionHash]);
  if (!receipt || receipt.status !== "0x1" || receipt.transactionHash.toLowerCase() !== job.transactionHash.toLowerCase()) {
    throw new Error(`${name} RPC receipt verification failed`);
  }
  if (BigInt(receipt.gasUsed).toString() !== job.receipt.gasUsed || BigInt(receipt.effectiveGasPrice).toString() !== job.receipt.effectiveGasPrice) {
    throw new Error(`${name} receipt fee fields disagree with the saved job`);
  }

  const relevantGasHistory = history.observations.filter((observation) =>
    observation.observedAtMs >= job.requestedAtMs - 2_000 &&
    observation.observedAtMs <= Date.parse(job.confirmedAt) + 2_000
  );
  const record = {
    schemaVersion: "authorized-demonstration/1.0.0",
    capturedAt,
    historical: true,
    readOnlyVerification: true,
    provenance: {
      application: base,
      jobEndpoint: `${base}/api/jobs/${id}`,
      rpcNetwork: "Pharos Atlantic Testnet",
      rpcChainId: chainId,
      receiptMethod: "eth_getTransactionReceipt",
      balanceMethod: "eth_getBalance",
    },
    job,
    rpcReceiptVerification: {
      verified: true,
      transactionHash: receipt.transactionHash,
      blockHash: receipt.blockHash,
      blockNumber: BigInt(receipt.blockNumber).toString(),
      status: BigInt(receipt.status).toString(),
      from: receipt.from,
      to: receipt.to,
      gasUsed: BigInt(receipt.gasUsed).toString(),
      effectiveGasPrice: BigInt(receipt.effectiveGasPrice).toString(),
      actualFeeWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(),
    },
    balanceAfterBothDemonstrationsWei: balanceWei,
    relevantGasHistory,
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(`evidence/${name}.json`, text);
  await writeFile(`public/evidence/${name}.json`, text);
  manifest.examples[name] = {
    jobId: id,
    releaseReason: job.releaseReason,
    transactionHash: job.transactionHash,
    state: job.state,
    actualFeeWei: record.rpcReceiptVerification.actualFeeWei,
    evidencePath: `evidence/${name}.json`,
  };
}

const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile("evidence/manifest-v1.json", manifestText);
await writeFile("public/evidence/manifest-v1.json", manifestText);
console.log(JSON.stringify(manifest, null, 2));
