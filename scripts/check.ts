import { network } from "hardhat"

const { ethers } = await network.connect()
const [signer] = await ethers.getSigners()
const balance = await ethers.provider.getBalance(signer.address)

console.log("address:", signer.address)
console.log("balance:", ethers.formatEther(balance), "ETH")
