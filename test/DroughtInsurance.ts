import { expect } from "chai";
import { network } from "hardhat";

// getOrCreate() reuses an existing connection for the network if one is open, rather than always making a new one
const { ethers, networkHelpers } = await network.getOrCreate();
const { time } = networkHelpers;

const PREMIUM = ethers.parseEther("0.01");
const PAYOUT = ethers.parseEther("0.1");
const THRESHOLD_MM = 200n;
const REGION = "Wagga Wagga";
const ETH_USD = 300000000000n; // $3000.00, 8 decimals

async function deployFixture() {
  const [insurer, oracle, farmer] = await ethers.getSigners();

  const mockFeed = await ethers.deployContract("MockV3Aggregator", [ETH_USD]);
  const insurance = await ethers.deployContract(
    "DroughtInsurance",
    [oracle.address, await mockFeed.getAddress()],
    { value: ethers.parseEther("1") },
  );

  const seasonEnd = BigInt(await time.latest()) + 30n * 24n * 60n * 60n;

  return { insurance, mockFeed, insurer, oracle, farmer, seasonEnd };
}

describe("DroughtInsurance", () => {
  describe("createPolicy", () => {
    it("creates a policy and emits PolicyCreated", async () => {
      const { insurance, seasonEnd } = await deployFixture();

      await expect(
        insurance.createPolicy(
          REGION,
          THRESHOLD_MM,
          PREMIUM,
          PAYOUT,
          seasonEnd,
        ),
      )
        .to.emit(insurance, "PolicyCreated")
        .withArgs(0n, REGION, THRESHOLD_MM, PREMIUM, PAYOUT, seasonEnd);

      expect(await insurance.policyCount()).to.equal(1n);
    });

    it("reverts when a non-insurer calls", async () => {
      const { insurance, farmer, seasonEnd } = await deployFixture();

      await expect(
        insurance
          .connect(farmer)
          .createPolicy(REGION, THRESHOLD_MM, PREMIUM, PAYOUT, seasonEnd),
      ).to.be.revertedWithCustomError(insurance, "NotInsurer");
    });

    it("reverts when seasonEnd is in the past", async () => {
      const { insurance } = await deployFixture();
      const past = BigInt(await time.latest()) - 1n;

      await expect(
        insurance.createPolicy(REGION, THRESHOLD_MM, PREMIUM, PAYOUT, past),
      ).to.be.revertedWithCustomError(insurance, "InvalidSeasonEnd");
    });

    it("reverts when payouts would exceed unreserved capital", async () => {
      const { insurance, seasonEnd } = await deployFixture();
      const big = ethers.parseEther("0.6");

      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        big,
        seasonEnd,
      );

      await expect(
        insurance.createPolicy(REGION, THRESHOLD_MM, PREMIUM, big, seasonEnd),
      ).to.be.revertedWithCustomError(insurance, "PayoutNotFunded");
    });
  });

  describe("purchasePolicy", () => {
    it("records the policyholder and emits PolicyPurchased", async () => {
      const { insurance, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      await expect(
        insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM }),
      )
        .to.emit(insurance, "PolicyPurchased")
        .withArgs(0n, farmer.address, PREMIUM, ETH_USD);

      const policy = await insurance.policies(0);
      expect(policy.policyholder).to.equal(farmer.address);
      expect(policy.state).to.equal(1n); // Purchased
    });

    it("reverts on underpayment", async () => {
      const { insurance, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      await expect(
        insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM - 1n }),
      ).to.be.revertedWithCustomError(insurance, "IncorrectPremium");
    });

    it("reverts on overpayment", async () => {
      const { insurance, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      await expect(
        insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM + 1n }),
      ).to.be.revertedWithCustomError(insurance, "IncorrectPremium");
    });

    it("reverts when already purchased", async () => {
      const { insurance, farmer, insurer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );
      await insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM });

      await expect(
        insurance.connect(insurer).purchasePolicy(0, { value: PREMIUM }),
      ).to.be.revertedWithCustomError(insurance, "PolicyNotOpen");
    });

    it("reverts when the season has ended", async () => {
      const { insurance, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      await time.increaseTo(seasonEnd);

      await expect(
        insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM }),
      ).to.be.revertedWithCustomError(insurance, "SeasonAlreadyEnded");
    });

    it("reverts when the price feed is stale", async () => {
      const { insurance, mockFeed, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      const now = BigInt(await time.latest());
      await mockFeed.setUpdatedAt(now - 4n * 60n * 60n);

      await expect(
        insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM }),
      ).to.be.revertedWithCustomError(insurance, "StalePriceFeed");
    });

    it("reverts when the price feed returns a non-positive answer", async () => {
      const { insurance, mockFeed, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      await mockFeed.setAnswer(0);

      await expect(
        insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM }),
      ).to.be.revertedWithCustomError(insurance, "StalePriceFeed");
    });
  });

  describe("reportRainfall", () => {
    it("records rainfall and emits RainfallReported", async () => {
      const { insurance, oracle } = await deployFixture();

      await expect(
        insurance.connect(oracle).reportRainfall(REGION, 150n),
      ).to.emit(insurance, "RainfallReported");

      expect(await insurance.rainfallMm(REGION)).to.equal(150n);
      expect(await insurance.rainfallReportedAt(REGION)).to.be.greaterThan(0n);
    });

    it("reverts when a non-oracle calls", async () => {
      const { insurance, farmer } = await deployFixture();

      await expect(
        insurance.connect(farmer).reportRainfall(REGION, 150n),
      ).to.be.revertedWithCustomError(insurance, "NotOracle");
    });

    it("reverts when the insurer calls", async () => {
      const { insurance, insurer } = await deployFixture();

      await expect(
        insurance.connect(insurer).reportRainfall(REGION, 150n),
      ).to.be.revertedWithCustomError(insurance, "NotOracle");
    });

    it("overwrites a previous reading", async () => {
      const { insurance, oracle } = await deployFixture();

      await insurance.connect(oracle).reportRainfall(REGION, 150n);
      await insurance.connect(oracle).reportRainfall(REGION, 220n);

      expect(await insurance.rainfallMm(REGION)).to.equal(220n);
    });

    it("keeps regions independent", async () => {
      const { insurance, oracle } = await deployFixture();

      await insurance.connect(oracle).reportRainfall(REGION, 150n);
      await insurance.connect(oracle).reportRainfall("Dubbo", 400n);

      expect(await insurance.rainfallMm(REGION)).to.equal(150n);
      expect(await insurance.rainfallMm("Dubbo")).to.equal(400n);
    });
  });

  describe("setOracle", () => {
    it("updates the oracle and emits OracleUpdated", async () => {
      const { insurance, oracle, farmer } = await deployFixture();

      await expect(insurance.setOracle(farmer.address))
        .to.emit(insurance, "OracleUpdated")
        .withArgs(oracle.address, farmer.address);

      expect(await insurance.oracle()).to.equal(farmer.address);
    });

    it("revokes the previous oracle", async () => {
      const { insurance, oracle, farmer } = await deployFixture();
      await insurance.setOracle(farmer.address);

      await expect(
        insurance.connect(oracle).reportRainfall(REGION, 150n),
      ).to.be.revertedWithCustomError(insurance, "NotOracle");
    });

    it("reverts on the zero address", async () => {
      const { insurance } = await deployFixture();

      await expect(
        insurance.setOracle(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(insurance, "InvalidOracle");
    });

    it("reverts when a non-insurer calls", async () => {
      const { insurance, farmer } = await deployFixture();

      await expect(
        insurance.connect(farmer).setOracle(farmer.address),
      ).to.be.revertedWithCustomError(insurance, "NotInsurer");
    });
  });

  describe("settlePolicy", () => {
    async function purchasedFixture() {
      const ctx = await deployFixture();
      await ctx.insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        ctx.seasonEnd,
      );
      await ctx.insurance
        .connect(ctx.farmer)
        .purchasePolicy(0, { value: PREMIUM });
      return ctx;
    }

    it("pays out when rainfall is below the threshold", async () => {
      const { insurance, oracle, farmer, seasonEnd } = await purchasedFixture();

      await insurance.connect(oracle).reportRainfall(REGION, 150n);
      await time.increaseTo(seasonEnd);

      const before = await ethers.provider.getBalance(farmer.address);
      await insurance.settlePolicy(0);
      const after = await ethers.provider.getBalance(farmer.address);

      expect(after - before).to.equal(PAYOUT);
    });

    it("does not pay out when rainfall meets the threshold", async () => {
      const { insurance, oracle, farmer, seasonEnd } = await purchasedFixture();

      await insurance.connect(oracle).reportRainfall(REGION, THRESHOLD_MM);
      await time.increaseTo(seasonEnd);

      const before = await ethers.provider.getBalance(farmer.address);
      await insurance.settlePolicy(0);
      const after = await ethers.provider.getBalance(farmer.address);

      expect(after - before).to.equal(0n);
    });

    it("emits PolicySettled with the triggered flag", async () => {
      const { insurance, oracle, farmer, seasonEnd } = await purchasedFixture();

      await insurance.connect(oracle).reportRainfall(REGION, 150n);
      await time.increaseTo(seasonEnd);

      await expect(insurance.settlePolicy(0))
        .to.emit(insurance, "PolicySettled")
        .withArgs(0n, farmer.address, true, 150n, PAYOUT);
    });

    it("reverts before the season has ended", async () => {
      const { insurance, oracle } = await purchasedFixture();
      await insurance.connect(oracle).reportRainfall(REGION, 150n);

      await expect(insurance.settlePolicy(0)).to.be.revertedWithCustomError(
        insurance,
        "SeasonNotEnded",
      );
    });

    it("reverts when no rainfall has been reported", async () => {
      const { insurance, seasonEnd } = await purchasedFixture();
      await time.increaseTo(seasonEnd);

      await expect(insurance.settlePolicy(0)).to.be.revertedWithCustomError(
        insurance,
        "NoRainfallData",
      );
    });

    it("cannot settle twice", async () => {
      const { insurance, oracle, seasonEnd } = await purchasedFixture();

      await insurance.connect(oracle).reportRainfall(REGION, 150n);
      await time.increaseTo(seasonEnd);
      await insurance.settlePolicy(0);

      await expect(insurance.settlePolicy(0)).to.be.revertedWithCustomError(
        insurance,
        "PolicyNotSettleable",
      );
    });

    it("cannot settle an unpurchased policy", async () => {
      const { insurance, oracle, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );
      await insurance.connect(oracle).reportRainfall(REGION, 150n);
      await time.increaseTo(seasonEnd);

      await expect(insurance.settlePolicy(0)).to.be.revertedWithCustomError(
        insurance,
        "PolicyNotSettleable",
      );
    });
  });

  describe("expirePolicy", () => {
    it("expires an unsold policy after season end", async () => {
      const { insurance, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );
      await time.increaseTo(seasonEnd);

      await expect(insurance.expirePolicy(0))
        .to.emit(insurance, "PolicyExpired")
        .withArgs(0n);

      const policy = await insurance.policies(0);
      expect(policy.state).to.equal(3n); // Expired
    });

    it("is callable by anyone", async () => {
      const { insurance, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );
      await time.increaseTo(seasonEnd);

      await expect(insurance.connect(farmer).expirePolicy(0)).to.not.revert(
        ethers,
      );
    });

    it("reverts before season end", async () => {
      const { insurance, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      await expect(insurance.expirePolicy(0)).to.be.revertedWithCustomError(
        insurance,
        "SeasonNotEnded",
      );
    });

    it("cannot expire a purchased policy", async () => {
      const { insurance, farmer, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );
      await insurance.connect(farmer).purchasePolicy(0, { value: PREMIUM });
      await time.increaseTo(seasonEnd);

      await expect(insurance.expirePolicy(0)).to.be.revertedWithCustomError(
        insurance,
        "PolicyNotExpirable",
      );
    });
  });

  describe("withdrawPool", () => {
    it("withdraws unreserved capital", async () => {
      const { insurance, insurer } = await deployFixture();
      const amount = ethers.parseEther("0.5");

      const before = await ethers.provider.getBalance(insurer.address);
      const tx = await insurance.withdrawPool(amount);
      const receipt = await tx.wait();
      const gas = receipt!.gasUsed * receipt!.gasPrice;
      const after = await ethers.provider.getBalance(insurer.address);

      expect(after - before + gas).to.equal(amount);
    });

    it("reserves capital against open policies", async () => {
      const { insurance, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );

      await expect(
        insurance.withdrawPool(ethers.parseEther("0.95")),
      ).to.be.revertedWithCustomError(insurance, "ReservedForPolicies");
    });

    it("releases reserved capital once a policy expires", async () => {
      const { insurance, seasonEnd } = await deployFixture();
      await insurance.createPolicy(
        REGION,
        THRESHOLD_MM,
        PREMIUM,
        PAYOUT,
        seasonEnd,
      );
      await time.increaseTo(seasonEnd);
      await insurance.expirePolicy(0);

      await expect(
        insurance.withdrawPool(ethers.parseEther("0.95")),
      ).to.not.revert(ethers);
    });

    it("reverts when a non-insurer calls", async () => {
      const { insurance, farmer } = await deployFixture();

      await expect(
        insurance.connect(farmer).withdrawPool(1n),
      ).to.be.revertedWithCustomError(insurance, "NotInsurer");
    });

    it("accepts pool funding and emits PoolFunded", async () => {
      const { insurance, insurer } = await deployFixture();
      const amount = ethers.parseEther("0.2");

      await expect(
        insurer.sendTransaction({
          to: await insurance.getAddress(),
          value: amount,
        }),
      )
        .to.emit(insurance, "PoolFunded")
        .withArgs(insurer.address, amount);
    });
  });

  describe("constructor", () => {
    it("reverts on a zero oracle address", async () => {
      const mockFeed = await ethers.deployContract("MockV3Aggregator", [
        ETH_USD,
      ]);

      await expect(
        ethers.deployContract("DroughtInsurance", [
          ethers.ZeroAddress,
          await mockFeed.getAddress(),
        ]),
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("DroughtInsurance"),
        "InvalidOracle",
      );
    });

    it("reverts on a zero price feed address", async () => {
      const [, oracle] = await ethers.getSigners();

      await expect(
        ethers.deployContract("DroughtInsurance", [
          oracle.address,
          ethers.ZeroAddress,
        ]),
      ).to.be.revertedWithCustomError(
        await ethers.getContractFactory("DroughtInsurance"),
        "InvalidOracle",
      );
    });
  });
});
