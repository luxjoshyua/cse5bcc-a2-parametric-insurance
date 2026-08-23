// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title MockV3Aggregator
 * @notice Minimal Chainlink price feed stand-in for local testing.
 * @dev Allows tests to set arbitrary answers and timestamps, including the
 *      stale and non-positive cases the contract is expected to reject.
 */
contract MockV3Aggregator {
    uint8 public decimals = 8;
    int256 private answer;
    uint256 private updatedAt;

    constructor(int256 initialAnswer) {
        answer = initialAnswer;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 newAnswer) external {
        answer = newAnswer;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 newUpdatedAt) external {
        updatedAt = newUpdatedAt;
    }

    function description() external pure returns (string memory) {
        return "Mock ETH/USD";
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}
