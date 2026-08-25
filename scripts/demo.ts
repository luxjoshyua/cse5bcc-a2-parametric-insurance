import { network } from "hardhat";

const CONTRACT = "0x87801B3214c7C6e1E1990ceC4c9c5adAa3D1aE70";
const REGION = "Wagga Wagga";
const THRESHOLD_MM = 200n;
const MEASURED_MM = 150n; // below threshold, so the policy triggers
const PREMIUM = 1_000_000_000_000_000n; // 0.001 ETH
const PAYOUT = 5_000_000_000_000_000n; // 0.005 ETH
const SEASON_SECONDS = 180;

const { ethers } = await network.getOrCreate();
const [insurer, oracle, farmer] = await ethers.getSigners();
const insurance = await ethers.getContractAt("DroughtInsurance", CONTRACT);

function log(label: string, hash: string): void {
  console.log(`${label}\n  tx: https://sepolia.etherscan.io/tx/${hash}\n`);
}

const block = await ethers.provider.getBlock("latest");
const seasonEnd = BigInt(block!.timestamp) + BigInt(SEASON_SECONDS);

console.log(`contract:  ${CONTRACT}`);
console.log(`insurer:   ${insurer.address}`);
console.log(`oracle:    ${oracle.address}`);
console.log(`farmer:    ${farmer.address}\n`);

// 1. Insurer creates a policy
const created = await insurance
  .connect(insurer)
  .createPolicy(REGION, THRESHOLD_MM, PREMIUM, PAYOUT, seasonEnd);
await created.wait();
const policyId = (await insurance.policyCount()) - 1n;
log(
  `1. createPolicy — id ${policyId}, region ${REGION}, threshold ${THRESHOLD_MM}mm`,
  created.hash,
);

// 2. Farmer purchases
const purchased = await insurance
  .connect(farmer)
  .purchasePolicy(policyId, { value: PREMIUM });
await purchased.wait();
log(
  `2. purchasePolicy — premium ${ethers.formatEther(PREMIUM)} ETH`,
  purchased.hash,
);

// 3. Oracle reports rainfall
const reported = await insurance
  .connect(oracle)
  .reportRainfall(REGION, MEASURED_MM);
await reported.wait();
log(
  `3. reportRainfall — ${MEASURED_MM}mm (threshold ${THRESHOLD_MM}mm)`,
  reported.hash,
);

// 4. Wait for the season to end
console.log(`4. waiting for season end...`);
while (true) {
  const now = await ethers.provider.getBlock("latest");
  const remaining = seasonEnd - BigInt(now!.timestamp);
  if (remaining <= 0n) break;
  console.log(`   ${remaining}s remaining`);
  await new Promise((r) => setTimeout(r, 15000));
}

// 5. Settle
const before = await ethers.provider.getBalance(farmer.address);
const settled = await insurance.connect(insurer).settlePolicy(policyId);
await settled.wait();
const after = await ethers.provider.getBalance(farmer.address);

console.log();
log(
  `5. settlePolicy — farmer received ${ethers.formatEther(after - before)} ETH`,
  settled.hash,
);
