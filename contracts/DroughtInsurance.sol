// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/**
 * @title DroughtInsurance
 * @author Joshua Fielding
 * @notice Parametric drought cover for Australian growers. Payouts trigger on a
 *         measured rainfall index falling below an agreed threshold, with no
 *         claims assessment or loss adjustment.
 * @dev Rainfall is supplied by a single permissioned oracle address, which is a
 *      deliberate trust assumption documented in the accompanying report.
 *      ETH/USD pricing uses a Chainlink AggregatorV3Interface feed.
 */
contract DroughtInsurance {
    enum PolicyState {
        Open,
        Purchased,
        Settled,
        Expired
    }

    struct Policy {
        string region;
        uint256 rainfallThresholdMm;
        uint256 premiumWei;
        uint256 payoutWei;
        uint256 seasonEnd;
        address policyholder;
        PolicyState state;
    }

    /// @notice Address that deployed the contract and funds the payout pool.
    address public immutable insurer;

    /// @notice Sole address permitted to report rainfall measurements.
    address public oracle;

    /// @dev Chainlink ETH/USD feed, recorded against purchases for auditability.
    AggregatorV3Interface internal immutable priceFeed;

    /// @notice Total policies created; doubles as the next policy identifier.
    uint256 public policyCount;

    /// @notice Policy records by identifier.
    mapping(uint256 => Policy) public policies;

    event PolicyCreated(
        uint256 indexed policyId,
        string region,
        uint256 rainfallThresholdMm,
        uint256 premiumWei,
        uint256 payoutWei,
        uint256 seasonEnd
    );

    /// @notice Emitted when a farmer purchases cover.
    event PolicyPurchased(
        uint256 indexed policyId,
        address indexed policyholder,
        uint256 premiumPaid,
        int256 ethUsdPrice
    );

    /// @notice Caller is not the insurer.
    error NotInsurer();

    /// @notice Season end must be in the future.
    error InvalidSeasonEnd();

    /// @notice Contract balance is insufficient to cover the payout.
    error PayoutNotFunded();

    /// @notice Policy is not available for purchase.
    error PolicyNotOpen();

    /// @notice Sent value does not match the required premium.
    error IncorrectPremium(uint256 expected, uint256 sent);

    /// @notice Season has already ended.
    error SeasonAlreadyEnded();

    /// @notice Price feed returned a non-positive or outdated answer.
    error StalePriceFeed();

    modifier onlyInsurer() {
        if (msg.sender != insurer) revert NotInsurer();
        _;
    }

    constructor(address _oracle, address _priceFeed) payable {
        insurer = msg.sender;
        oracle = _oracle;
        priceFeed = AggregatorV3Interface(_priceFeed);
    }

    /**
     * @notice Creates a new drought policy available for purchase.
     * @dev Reverts unless the contract already holds enough ETH to honour the
     *      payout, so cover is never advertised against an unfunded pool.
     * @param region Identifier for the rainfall station or district.
     * @param rainfallThresholdMm Payout triggers below this figure, in whole millimetres.
     * @param premiumWei Amount the policyholder must send, in wei.
     * @param payoutWei Amount paid on a triggered policy, in wei.
     * @param seasonEnd Unix timestamp after which the policy can no longer be purchased.
     * @return policyId Identifier assigned to the new policy.
     */
    function createPolicy(
        string calldata region,
        uint256 rainfallThresholdMm,
        uint256 premiumWei,
        uint256 payoutWei,
        uint256 seasonEnd
    ) external onlyInsurer returns (uint256 policyId) {
        if (seasonEnd <= block.timestamp) revert InvalidSeasonEnd();
        if (address(this).balance < payoutWei) revert PayoutNotFunded();

        policyId = policyCount++;

        policies[policyId] = Policy({
            region: region,
            rainfallThresholdMm: rainfallThresholdMm,
            premiumWei: premiumWei,
            payoutWei: payoutWei,
            seasonEnd: seasonEnd,
            policyholder: address(0),
            state: PolicyState.Open
        });

        emit PolicyCreated(policyId, region, rainfallThresholdMm, premiumWei, payoutWei, seasonEnd);
    }

    /**
     * @notice Purchases an open policy by paying the exact premium.
     * @dev Records the prevailing ETH/USD rate in the emitted event so the
     *      premium's fiat value at time of sale is auditable on-chain.
     * @param policyId Identifier of the policy to purchase.
     */
    function purchasePolicy(uint256 policyId) external payable {
        Policy storage policy = policies[policyId];

        if (policy.state != PolicyState.Open) revert PolicyNotOpen();
        if (block.timestamp >= policy.seasonEnd) revert SeasonAlreadyEnded();
        if (msg.value != policy.premiumWei) {
            revert IncorrectPremium(policy.premiumWei, msg.value);
        }

        policy.policyholder = msg.sender;
        policy.state = PolicyState.Purchased;

        emit PolicyPurchased(policyId, msg.sender, msg.value, _latestEthUsdPrice());
    }

    /**
     * @notice Reads the latest ETH/USD price from the Chainlink feed.
     * @dev Rejects non-positive answers and data older than three hours rather
     *      than trusting the feed blindly.
     * @return Latest price, scaled by the feed's decimals (8 for ETH/USD).
     */
    function _latestEthUsdPrice() internal view returns (int256) {
        (, int256 answer, , uint256 updatedAt, ) = priceFeed.latestRoundData();

        if (answer <= 0) revert StalePriceFeed();
        if (block.timestamp - updatedAt > 3 hours) revert StalePriceFeed();

        return answer;
    }
}
