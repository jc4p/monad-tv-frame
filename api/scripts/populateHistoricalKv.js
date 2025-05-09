// scripts/populateHistoricalKv.js

import dotenv from 'dotenv';
dotenv.config(); // Load .env file from current working directory or parent dirs

import { createPublicClient, http, parseAbiItem } from 'viem';
import fetch from 'node-fetch'; // Or Bun's built-in fetch if preferred and it behaves identically for this

// --- Configuration ---
const ALCHEMY_MONAD_RPC_URL = process.env.ALCHEMY_MONAD_RPC_URL; // Must be set in your environment
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN; // Needs KV write permissions
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const KV_NAMESPACE_ID_LOG_CACHE = process.env.KV_NAMESPACE_ID_LOG_CACHE; // Your LOG_CACHE namespace ID

const MONAD_TESTNET_CHAIN_ID = 10143;
const FRAME_RECORDER_CONTRACT_ADDRESS = '0x1B5481D98B0cD6b3422E15d6e16102C3780B08Ec';
const videoClipUpdatedEventAbi = parseAbiItem('event VideoClipUpdated(address indexed user, uint256 fid, uint256 timestamp)');

const START_BLOCK = 15592132n; // Your specified historical start block as BigInt
const RPC_BLOCK_RANGE_LIMIT = 1000; // How many blocks per getLogs call
const KV_HISTORICAL_CACHE_KEY = "monad-grid:historical_logs_v1";

// Optional: Delay between batches of RPC calls to be kind to RPC provider
const DELAY_BETWEEN_BATCHES_MS = 200; // e.g., 200ms
const CALLS_PER_BATCH = 5; // Make 5 getLogs calls, then pause

if (!ALCHEMY_MONAD_RPC_URL || !CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !KV_NAMESPACE_ID_LOG_CACHE) {
    console.error("Error: Missing required environment variables.");
    console.log("Please set: ALCHEMY_MONAD_RPC_URL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, KV_NAMESPACE_ID_LOG_CACHE");
    process.exit(1);
}

const monadTestnet = {
    id: MONAD_TESTNET_CHAIN_ID,
    name: 'Monad Testnet (Script)',
    network: 'monad-testnet-script',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [ALCHEMY_MONAD_RPC_URL] } },
    testnet: true,
};

const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(),
});

async function writeToKV(key, value) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${KV_NAMESPACE_ID_LOG_CACHE}/values/${key}`;
    console.log(`Attempting to write ${value.length} bytes to KV key: ${key}`);

    try {
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                'Content-Type': 'application/json', // KV expects JSON for this API, or text/plain
            },
            body: value, // Value should be a string
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Cloudflare API error: ${response.status} ${response.statusText} - ${errorText}`);
        }
        console.log(`Successfully wrote to KV key: ${key}`);
        return await response.json();
    } catch (error) {
        console.error(`Failed to write to KV for key ${key}:`, error);
        throw error;
    }
}

async function main() {
    console.log("Starting historical log population script...");
    console.log(`Fetching logs for contract: ${FRAME_RECORDER_CONTRACT_ADDRESS}`);
    console.log(`From block: ${START_BLOCK} up to latest.`);
    console.log(`Using RPC: ${ALCHEMY_MONAD_RPC_URL}`);
    console.log(`KV Namespace ID (first 8 chars): ${KV_NAMESPACE_ID_LOG_CACHE.substring(0,8)}...`);


    try {
        const currentLatestBlock = await publicClient.getBlockNumber();
        console.log(`Current latest block on chain: ${currentLatestBlock}`);

        if (START_BLOCK >= currentLatestBlock) {
            console.log("Start block is at or after the current latest block. No historical logs to fetch.");
            return;
        }

        let allHistoricalLogs = [];
        let currentQueryStartBlock = START_BLOCK;
        let rpcCallCount = 0;

        console.log(`Starting log fetching loop from ${currentQueryStartBlock} to ${currentLatestBlock}.`);

        while (currentQueryStartBlock <= currentLatestBlock) {
            let chunkToBlock = currentQueryStartBlock + BigInt(RPC_BLOCK_RANGE_LIMIT - 1);
            if (chunkToBlock > currentLatestBlock) {
                chunkToBlock = currentLatestBlock;
            }

            console.log(`Fetching logs for chunk: ${currentQueryStartBlock} to ${chunkToBlock}`);
            try {
                const chunkLogs = await publicClient.getLogs({
                    address: FRAME_RECORDER_CONTRACT_ADDRESS,
                    event: videoClipUpdatedEventAbi,
                    fromBlock: currentQueryStartBlock,
                    toBlock: chunkToBlock,
                });
                rpcCallCount++;

                if (chunkLogs && chunkLogs.length > 0) {
                    console.log(`Found ${chunkLogs.length} logs in chunk ${currentQueryStartBlock}-${chunkToBlock}.`);
                    const serializableLogs = chunkLogs.map(log =>
                        JSON.parse(JSON.stringify(log, (key, value) =>
                            typeof value === 'bigint' ? value.toString() : value
                        ))
                    );
                    allHistoricalLogs = allHistoricalLogs.concat(serializableLogs);
                }
            } catch (chunkError) {
                console.error(`Error fetching logs for chunk ${currentQueryStartBlock}-${chunkToBlock}:`, chunkError.message);
                // Consider a retry mechanism or stopping on persistent errors
                console.log("Pausing for 5 seconds before retrying or continuing...");
                await new Promise(resolve => setTimeout(resolve, 5000));
            }

            if (chunkToBlock === currentLatestBlock) {
                console.log("Reached target latest block for historical fetch.");
                break;
            }
            currentQueryStartBlock = chunkToBlock + 1n;

            if (rpcCallCount % CALLS_PER_BATCH === 0 && DELAY_BETWEEN_BATCHES_MS > 0) {
                console.log(`Completed batch of ${CALLS_PER_BATCH} calls. Pausing for ${DELAY_BETWEEN_BATCHES_MS}ms...`);
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
            }
        }

        console.log(`Total historical logs fetched: ${allHistoricalLogs.length}`);

        if (allHistoricalLogs.length > 0) {
            // Sort logs by timestamp newest first before saving (optional, but good practice)
            allHistoricalLogs.sort((a, b) => Number(b.args.timestamp) - Number(a.args.timestamp));
            
            const payloadToStore = {
                logs: allHistoricalLogs,
                fetchedUpToBlock: currentLatestBlock.toString(),
                populationDate: new Date().toISOString(),
            };
            // KV expects value as a string. Max size for single write is 25MB.
            // If logs are huge, might need to chunk for KV too, or store less metadata per log.
            const stringValue = JSON.stringify(payloadToStore);
            
            // Check size (approximate)
             const stringValueBytes = new TextEncoder().encode(stringValue).length;
            console.log(`Approximate size of data to store in KV: ${(stringValueBytes / (1024*1024)).toFixed(2)} MB`);
            if (stringValueBytes > 20 * 1024 * 1024) { // Safety margin below 25MB
                 console.warn("Warning: Data size is large, approaching KV value size limit. Consider chunking for KV if this fails.");
            }

            await writeToKV(KV_HISTORICAL_CACHE_KEY, stringValue);
            console.log("Historical log population complete and data stored in KV.");
        } else {
            console.log("No historical logs found in the specified range.");
        }

    } catch (error) {
        console.error('Critical error in historical log population script:', error);
    }
}

main(); 