import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SEPOLIA_ETH_USD_FEED = "0x694AA1769357215DE4FAC081bf1f309aDC325306";
const INITIAL_POOL = 20_000_000_000_000_000n; // 0.02 ETH

export default buildModule("DroughtInsuranceModule", (m) => {
  const oracle = m.getParameter("oracle");
  const priceFeed = m.getParameter("priceFeed", SEPOLIA_ETH_USD_FEED);
  const poolFunding = m.getParameter("poolFunding", INITIAL_POOL);

  const insurance = m.contract("DroughtInsurance", [oracle, priceFeed], {
    value: poolFunding,
  });

  return { insurance };
});
