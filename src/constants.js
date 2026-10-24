export const NETWORK={name:"Pharos Atlantic Testnet",chainId:688689,nativeSymbol:"PHRS",rpcUrl:"https://atlantic.dplabs-internal.com",explorer:"https://atlantic.pharosscan.xyz"};
export const STATES=["QUEUED","WAITING_FOR_GAS","READY_FAVORABLE","READY_DEADLINE","SUBMITTING","BROADCAST","CONFIRMED","FAILED","CANCELLED","DEADLINE_FAILURE"];
export const TERMINAL=new Set(["CONFIRMED","FAILED","CANCELLED","DEADLINE_FAILURE"]);
export const ENGINE_VERSION="gas-fee-optimizer/0.2.0-durable-submission";
