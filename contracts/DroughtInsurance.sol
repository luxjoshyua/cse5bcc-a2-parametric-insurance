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

    /// @notice Latest reported rainfall in millimetres, by region.
    mapping(string => uint256) public rainfallMm;

    /// @notice Timestamp of the latest rainfall report, by region.
    mapping(string => uint256) public rainfallReportedAt;

    /// @notice Emitted when the insurer creates a new policy.
    /// @param policyId Identifier assigned to the new policy.
    /// @param region Identifier for the rainfall station or district.
    /// @param rainfallThresholdMm Payout triggers below this figure, in whole millimetres
    /// @param premiumWei Amount the policyholder must send, in wei.
    /// @param payoutWei Amount paid on a triggered policy, in wei.
    /// @param seasonEnd Unix timestamp after which the policy can no longer be purchased.
    event PolicyCreated(
        uint256 indexed policyId,
        string region,
        uint256 rainfallThresholdMm,
        uint256 premiumWei,
        uint256 payoutWei,
        uint256 seasonEnd
    );

    /// @notice Emitted when a farmer purchases cover.
    /// @param policyId Identifier of the purchased policy.
    /// @param policyholder Address of the farmer who purchased the policy.
    /// @param premiumPaid Amount of ETH sent to purchase the policy, in wei.
    /// @param ethUsdPrice ETH/USD price at time of purchase, scaled by the feed's decimals (8 for ETH/USD).
    event PolicyPurchased(
        uint256 indexed policyId,
        address indexed policyholder,
        uint256 premiumPaid,
        int256 ethUsdPrice
    );

    /// @notice Emitted when a policy settles, whether or not it paid out.
    /// @param policyId Identifier of the settled policy.
    /// @param policyholder Address of the farmer who purchased the policy.
    /// @param triggered True if the policy paid out, false otherwise.
    /// @param rainfallMm Measured rainfall in millimetres for the policy's region.
    /// @param payoutWei Amount paid to the policyholder, in wei (0 if not triggered).
    event PolicySettled(
        uint256 indexed policyId,
        address indexed policyholder,
        bool triggered,
        uint256 rainfallMm,
        uint256 payoutWei
    );

    /// @notice Emitted when the insurer withdraws unspent pool capital.
    /// @param to Address receiving the withdrawn funds.
    /// @param amountWei Amount withdrawn, in wei.
    event PoolWithdrawn(address indexed to, uint256 amountWei);

    /// @notice Emitted when the pool receives funding.
    /// @param from Address providing the funding.
    /// @param amountWei Amount funded, in wei.
    event PoolFunded(address indexed from, uint256 amountWei);

    /// @notice Emitted when the oracle reports a rainfall measurement.
    /// @param region Identifier for the rainfall station or district.
    /// @param rainfallMm Cumulative rainfall for the season, in whole millimetres.
    /// @param reportedAt Block timestamp at which the measurement was recorded.
    event RainfallReported(string indexed region, uint256 rainfallMm, uint256 reportedAt);

    /// @notice Emitted when the insurer changes the oracle address.
    /// @param previousOracle Address previously authorised to report rainfall.
    /// @param newOracle Address now authorised to report rainfall.
    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    /// @notice Emitted when an unsold policy expires at season end.
    /// @param policyId Identifier of the expired policy.
    event PolicyExpired(uint256 indexed policyId);

    /// @notice Withdrawal would leave outstanding policies unfunded.
    error ReservedForPolicies(uint256 available, uint256 requested);

    /// @notice Withdrawal transfer failed.
    error WithdrawalFailed();

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

    /// @notice Policy is not in a settleable state.
    error PolicyNotSettleable();

    /// @notice Season has not ended yet.
    error SeasonNotEnded();

    /// @notice No rainfall has been reported for this region.
    error NoRainfallData();

    /// @notice Payout transfer failed.
    error PayoutFailed();

    /// @notice Caller is not the authorised oracle.
    error NotOracle();

    /// @notice Oracle address cannot be the zero address.
    error InvalidOracle();

    /// @notice Policy is not open, so cannot expire.
    error PolicyNotExpirable();

    modifier onlyInsurer() {
        if (msg.sender != insurer) revert NotInsurer();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    constructor(address _oracle, address _priceFeed) payable {
        insurer = msg.sender;
        oracle = _oracle;
        priceFeed = AggregatorV3Interface(_priceFeed);
    }

    /**
     * @notice Creates a new drought policy available for purchase.
     * @dev Reverts unless unreserved capital covers the payout, so cover is
     *      never advertised against funds already committed elsewhere.
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
        uint256 available = address(this).balance - _reservedCapital();
        if (available < payoutWei) revert PayoutNotFunded();

        // Post-increment is deliberate: returns the current count as the new
        // policy id, then advances. Pre-increment would offset every id by one.
        // solhint-disable-next-line gas-increment-by-one
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

    /**
     * @notice Records a rainfall measurement for a region.
     * @dev Overwrites any previous reading. Settlement uses whichever value is
     *      current when it runs, so report ordering matters.
     * @param region Identifier for the rainfall station or district.
     * @param measuredMm Cumulative rainfall for the season, in whole millimetres.
     */
    function reportRainfall(string calldata region, uint256 measuredMm) external onlyOracle {
        rainfallMm[region] = measuredMm;
        rainfallReportedAt[region] = block.timestamp;

        emit RainfallReported(region, measuredMm, block.timestamp);
    }

    /**
     * @notice Replaces the authorised oracle address.
     * @dev Provides a recovery path if the oracle key is lost or compromised,
     *      though it also concentrates trust in the insurer.
     * @param newOracle Address permitted to report rainfall from now on.
     */
    function setOracle(address newOracle) external onlyInsurer {
        if (newOracle == address(0)) revert InvalidOracle();

        emit OracleUpdated(oracle, newOracle);
        oracle = newOracle;
    }

    /**
     * @notice Settles a purchased policy once its season has ended.
     * @dev Follows checks-effects-interactions: state moves to Settled before
     *      any ETH is sent, so a reentrant call finds the policy already
     *      settled and reverts on the state check.
     * @param policyId Identifier of the policy to settle.
     */
    function settlePolicy(uint256 policyId) external {
        Policy storage policy = policies[policyId];

        // Checks
        if (policy.state != PolicyState.Purchased) revert PolicyNotSettleable();
        if (block.timestamp < policy.seasonEnd) revert SeasonNotEnded();
        if (rainfallReportedAt[policy.region] == 0) revert NoRainfallData();

        uint256 measured = rainfallMm[policy.region];
        bool triggered = measured < policy.rainfallThresholdMm;
        address policyholder = policy.policyholder;
        uint256 payout = triggered ? policy.payoutWei : 0;

        // Effects
        policy.state = PolicyState.Settled;

        emit PolicySettled(policyId, policyholder, triggered, measured, payout);

        // Interactions
        if (triggered) {
            (bool sent, ) = policyholder.call{value: payout}("");
            if (!sent) revert PayoutFailed();
        }
    }

    /**
     * @notice Withdraws unreserved capital from the payout pool.
     * @dev Reserves the full payout value of every unsettled policy, so the
     *      insurer can only remove genuinely surplus funds. Prevents draining
     *      the pool out from under live cover.
     * @param amountWei Amount to withdraw, in wei.
     */
    function withdrawPool(uint256 amountWei) external onlyInsurer {
        uint256 reserved = _reservedCapital();
        uint256 available = address(this).balance - reserved;

        if (amountWei > available) revert ReservedForPolicies(available, amountWei);

        emit PoolWithdrawn(msg.sender, amountWei);

        (bool sent, ) = msg.sender.call{value: amountWei}("");
        if (!sent) revert WithdrawalFailed();
    }

    /**
     * @notice Total payout value reserved against unsettled policies.
     * @dev Iterates all policies, so gas grows linearly with policyCount. Fine
     *      at demonstration scale; a running counter would be required in
     *      production.
     * @return reserved Sum of payouts owed on Open and Purchased policies.
     */
    function _reservedCapital() internal view returns (uint256 reserved) {
        for (uint256 i = 0; i < policyCount; ++i) {
            PolicyState state = policies[i].state;
            if (state == PolicyState.Open || state == PolicyState.Purchased) {
                reserved += policies[i].payoutWei;
            }
        }
    }

    /**
     * @notice Marks an unsold policy as expired once its season has ended.
     * @dev Releases the payout reserved against an Open policy that nobody
     *      purchased. Without this, unsold cover would reserve capital
     *      indefinitely and the insurer could never recover it. Callable by
     *      anyone, since expiry is determined entirely by on-chain state.
     * @param policyId Identifier of the policy to expire.
     */
    function expirePolicy(uint256 policyId) external {
        Policy storage policy = policies[policyId];

        if (policy.state != PolicyState.Open) revert PolicyNotExpirable();
        if (block.timestamp < policy.seasonEnd) revert SeasonNotEnded();

        policy.state = PolicyState.Expired;

        emit PolicyExpired(policyId);
    }

    /**
     * @notice Accepts ETH to fund the payout pool.
     */
    receive() external payable {
        emit PoolFunded(msg.sender, msg.value);
    }
}
