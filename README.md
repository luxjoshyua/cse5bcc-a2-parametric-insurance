# DroughtInsurance: Parametric Drought Cover on Sepolia

A Solidity smart contract for parametric drought insurance. A policy pays out automatically when oracle-reported seasonal rainfall at a nominated station falls below an agreed threshold, with no claims assessment.

Submitted for CSE5BCC Assessment 2 (Option 1: Technical Development Path), La Trobe University.

## Deployed Contract

| Item | Value |
| --- | --- |
| Network | Ethereum Sepolia (chain ID 11155111) |
| Contract address | `0x87801B3214c7C6e1E1990ceC4c9c5adAa3D1aE70` |
| Etherscan | https://sepolia.etherscan.io/address/0x87801B3214c7C6e1E1990ceC4c9c5adAa3D1aE70#code |
| Deployment tx | `0xe7fc316f9167aec72e1b43d7bd3b42ea9be6247099cebb4787e4ed8f9a3bb65f` |
| Chainlink ETH/USD feed | `0x694AA1769357215DE4FAC081bf1f309aDC325306` |

## Prerequisites

- Node.js 22 or later
- pnpm 11 (the repo pins `pnpm@11.22.0` via `packageManager`; run `corepack enable` to use it)
- An Alchemy account with a Sepolia RPC endpoint
- An Etherscan API key (for verification)
- Three Sepolia accounts, one per role, each funded with test ETH:
  - **Insurer:** deploys the contract and funds the pool (needs at least 0.03 ETH: 0.02 ETH pool funding plus gas)
  - **Oracle:** reports rainfall (gas only)
  - **Farmer:** purchases a policy (0.001 ETH premium plus gas)
- Python 3 (optional, for Slither static analysis)

## Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/luxjoshyua/cse5bcc-a2-parametric-insurance.git
cd cse5bcc-a2-parametric-insurance
pnpm install
```

Copy the environment template and fill in each value:

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `SEPOLIA_RPC_URL` | Alchemy Sepolia endpoint, e.g. `https://eth-sepolia.g.alchemy.com/v2/<key>` |
| `PRIVATE_KEY` | Insurer account (signer 0): deploys, funds, and creates policies |
| `ORACLE_PRIVATE_KEY` | Oracle account (signer 1): reports rainfall |
| `FARMER_PRIVATE_KEY` | Farmer account (signer 2): purchases cover |
| `ETHERSCAN_API_KEY` | Used by `hardhat-verify` to verify the source |

Then set the oracle address in `ignition/parameters.json` to the public address of your `ORACLE_PRIVATE_KEY` account:

```json
{
  "DroughtInsuranceModule": {
    "oracle": "0xYourOracleAddress"
  }
}
```

Confirm all three accounts are loaded and funded:

```bash
pnpm hardhat run scripts/check.ts --network sepolia
```

## Test and Analyse

Compile and run the unit test suite on the local Hardhat network:

```bash
pnpm hardhat compile
pnpm hardhat test
```

Lint the Solidity source:

```bash
pnpm lint
```

Run Slither static analysis (optional):

```bash
python3 -m venv .venv-security
source .venv-security/bin/activate
pip install slither-analyzer
slither .
```

## Deploy and Verify

Deploy the contract, fund the pool with 0.02 ETH, and verify the source in a single command:

```bash
pnpm hardhat ignition deploy ignition/modules/DroughtInsurance.ts \
  --network sepolia \
  --parameters ignition/parameters.json \
  --deployment-id my-deployment \
  --verify
```

Ignition writes the new contract address to `ignition/deployments/my-deployment/deployed_addresses.json` and records every transaction hash in `journal.jsonl` in the same folder.

The module accepts two optional parameters in `ignition/parameters.json`:

| Parameter | Default |
| --- | --- |
| `priceFeed` | `0x694AA1769357215DE4FAC081bf1f309aDC325306` (Chainlink ETH/USD on Sepolia) |
| `poolFunding` | `20000000000000000` (0.02 ETH, in wei) |

If verification fails (for example, Etherscan has not yet indexed the contract), rerun it separately:

```bash
pnpm hardhat verify --network sepolia <contract-address> <oracle-address> 0x694AA1769357215DE4FAC081bf1f309aDC325306
```

## Run the Demo Lifecycle

`scripts/demo.ts` exercises the full policy lifecycle against the deployed contract in four transactions:

1. **createPolicy:** the insurer creates a policy for Wagga Wagga with a 200 mm threshold, a 0.001 ETH premium, a 0.005 ETH payout, and a 180-second season
2. **purchasePolicy:** the farmer pays the premium
3. **reportRainfall:** the oracle reports 150 mm, below the threshold
4. **settlePolicy:** once the season ends, settlement transfers 0.005 ETH to the farmer

The script targets the contract address in its `CONTRACT` constant. To run it against your own deployment, replace that value with the address from your `deployed_addresses.json`, then run:

```bash
pnpm hardhat run scripts/demo.ts --network sepolia
```

The script waits roughly three minutes for the season to end, since a live network cannot advance time as the local tests do. Each step prints an Etherscan link to its transaction. Output from the submitted run is in `docs/demo-output.txt`.