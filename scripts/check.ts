import { network } from "hardhat";

const { ethers } = await network.getOrCreate();
const signers = await ethers.getSigners();
const labels = ["insurer", "oracle", "farmer"];

for (const [i, signer] of signers.entries()) {
  const balance = await ethers.provider.getBalance(signer.address);
  console.log(
    `${labels[i] ?? i}: ${signer.address} — ${ethers.formatEther(balance)} ETH`,
  );
}
