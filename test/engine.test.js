import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validateJob, releaseDecision, nextWake, safeToSubmit, costComparison, canCancel } from "../src/engine.js";
import { formatUnits, parseUnits, percentDifference } from "../src/math.js";
import { quantity } from "../src/rpc.js";
import { formatGwei, parseUtcDatetimeLocal } from "../public/app-utils.js";

const recipient="0x1111111111111111111111111111111111111111";
const config={allowedRecipient:recipient,maxTransferWei:"1000000000000000",maxTotalSpendWei:"10000000000000000"};
const input={chainId:688689,recipient,valuePhRS:"0.0001",preferredGasGwei:"1",maxAuthorizedFeePhRS:"0.001",deadlineUtc:"2030-01-01T00:00:00.000Z",monitoringIntervalSec:30};
const job={...validateJob(input,Date.parse("2029-01-01"),config),initialGasPriceWei:"1000000000",initialGasEstimate:"21000",baselineEstimatedFeeWei:"21000000000000"};

test("exact signed display arithmetic",()=>{assert.equal(parseUnits("0.000000000000000001"),1n);assert.equal(formatUnits(-1234500000000000000n,18,18),"-1.2345");assert.equal(percentDifference(1000n,995n).percent,"+0.50%");assert.equal(percentDifference(1000n,1005n).percent,"-0.50%");assert.equal(formatGwei("1"),"0.000000001")});
test("release, deadline and safety decisions remain exact",()=>{assert.equal(releaseDecision(job,{gasPriceWei:"1000000000"},job.deadlineMs-1000).state,"READY_FAVORABLE");assert.equal(releaseDecision(job,{gasPriceWei:"1000000001"},job.deadlineMs-1000).state,"WAITING_FOR_GAS");assert.equal(releaseDecision(job,{gasPriceWei:"999999999999"},job.deadlineMs).state,"READY_DEADLINE");assert.equal(nextWake({...job,monitoringIntervalSec:300},job.deadlineMs-1000),job.deadlineMs);assert.equal(safeToSubmit(job,"1000000000000","21000",{remainingSpendWei:"999999999999999999"}).reason,"CURRENT_FEE_EXCEEDS_JOB_MAXIMUM")});
test("cost comparison exposes signed padded percent",()=>{const c=costComparison({...job,initialGasPriceWei:"1000",baselineEstimatedFeeWei:"21000000"},{gasUsed:"1",effectiveGasPrice:"995"});assert.equal(c.difference.percent,"+0.50%");assert.equal(costComparison(job,{gasUsed:"21000",effectiveGasPrice:null}),null)});
test("configuration fails closed",()=>{assert.throws(()=>validateJob(input,Date.parse("2029-01-01"),{...config,allowedRecipient:"UNCONFIGURED"}),/allowlist/);assert.throws(()=>validateJob(input,Date.parse("2029-01-01"),{...config,maxTotalSpendWei:"-1"}),/Aggregate/);assert.throws(()=>validateJob({...input,recipient:"0x2222222222222222222222222222222222222222"},Date.parse("2029-01-01"),config),/not approved/)});
test("RPC quantities reject malformed or negative values",()=>{assert.equal(quantity("0x0"),0n);assert.equal(quantity("0x2a"),42n);for(const value of [null,"","0x","0x01","-0x1","12","0xz"])assert.throws(()=>quantity(value),/malformed/)});
test("UTC local input is timezone independent in UTC and Asia Tehran",()=>{assert.equal(parseUtcDatetimeLocal("2030-01-02T03:04:05"),"2030-01-02T03:04:05.000Z");assert.throws(()=>parseUtcDatetimeLocal("2030-02-30T03:04:05"),/valid UTC/);const moduleUrl=pathToFileURL(new URL("../public/app-utils.js",import.meta.url).pathname.replace(/^\/(.:)/,"$1")).href;const script=`import('${moduleUrl}').then(m=>console.log(m.parseUtcDatetimeLocal('2030-01-02T03:04:05')))`;for(const TZ of ["UTC","Asia/Tehran"])assert.equal(execFileSync(process.execPath,["--input-type=module","-e",script],{env:{...process.env,TZ},encoding:"utf8"}).trim(),"2030-01-02T03:04:05.000Z")});
test("cancellation boundary excludes submission",()=>{assert.equal(canCancel({state:"WAITING_FOR_GAS"}),true);assert.equal(canCancel({state:"SUBMITTING"}),false)});
