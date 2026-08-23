import { network } from "hardhat";

const { ethers } = await network.getOrCreate();
const [signer] = await ethers.getSigners();
const balance = await ethers.provider.getBalance(signer.address);

console.log("address:", signer.address);
console.log("balance:", ethers.formatEther(balance), "ETH");
