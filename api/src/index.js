/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { createPublicClient, http, parseAbiItem } from 'viem';
// Assuming Monad Testnet chain details are relatively stable
// or you can pass them/configure them more dynamically if needed.
const MONAD_TESTNET_CHAIN_ID = 10143; 
// const MONAD_NATIVE_CURRENCY = { name: 'Monad', symbol: 'MON', decimals: 18 };

// Contract and Event details
const FRAME_RECORDER_CONTRACT_ADDRESS = '0x1B5481D98B0cD6b3422E15d6e16102C3780B08Ec';
const videoClipUpdatedEventAbi = parseAbiItem('event VideoClipUpdated(address indexed user, uint256 fid, uint256 timestamp)');

const BLOCK_RANGE_LIMIT = 1000; // Alchemy's limit
const CACHE_KEY = "monad-grid:all_video_clip_logs_v1"; // Namespaced and versioned cache key
const CACHE_TTL_SECONDS = 2 * 60; // 2 minutes

// CORS settings applied to all responses
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export default {
	async fetch(request, env, ctx) {
		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: CORS_HEADERS });
		}
		const url = new URL(request.url);
		console.log(`Worker received request for: ${url.pathname}`);

		// Only respond to /recent endpoint
		if (url.pathname !== '/recent') {
			console.log(`Path ${url.pathname} not /recent. Returning 404.`);
			return new Response('Not Found. Try /recent endpoint.', {
				status: 404,
				headers: CORS_HEADERS
			});
		}

		// RPC URL check (moved after path check)
		const rpcUrl = env.ALCHEMY_MONAD_RPC_URL;
		if (!rpcUrl) {
			console.error("ALCHEMY_MONAD_RPC_URL not found in worker environment.");
			return new Response('ALCHEMY_MONAD_RPC_URL not configured', {
				status: 500,
				headers: CORS_HEADERS
			});
		}

		// Check KV Cache first
		if (env.LOG_CACHE) {
			try {
				console.log(`Checking KV cache for key: ${CACHE_KEY}`);
				const cachedData = await env.LOG_CACHE.get(CACHE_KEY, { type: "json" });
				if (cachedData) {
					console.log("Cache hit! Returning cached logs.");
					// No need to check TTL explicitly here if we set it on PUT
					// KV handles expiry. If get returns data, it's not expired.
					return new Response(JSON.stringify(cachedData), {
						headers: {
							...CORS_HEADERS,
							'Content-Type': 'application/json',
							'X-Cache-Status': 'HIT'
						}
					});
				} else {
					console.log("Cache miss.");
				}
			} catch (kvError) {
				console.error("Error reading from KV cache:", kvError);
				// Proceed to fetch from origin, don't let KV error block service
			}
		} else {
			console.warn("LOG_CACHE KV namespace not bound or available.");
		}

		console.log("Proceeding to fetch logs from RPC...");

		// Define the Monad Testnet chain object for Viem
		// Note: For workers, you often define chains inline or import them if using a larger Viem setup.
		// Keeping it simple here.
		const monadTestnet = {
			id: MONAD_TESTNET_CHAIN_ID,
			name: 'Monad Testnet (Worker)',
			network: 'monad-testnet-worker',
			nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
			rpcUrls: {
				default: { http: [rpcUrl] },
				public: { http: [rpcUrl] }, // Often same as default for single provider
			},
			testnet: true,
		};

		try {
			console.log(`Using RPC URL: ${rpcUrl}`);
			const publicClient = createPublicClient({
				chain: monadTestnet,
				transport: http(), // Viem will use the rpcUrl from the chain definition
			});

			console.log("Fetching latest block number...");
			const latestBlock = await publicClient.getBlockNumber();
			console.log(`Latest block number: ${latestBlock}`);

			let allLogs = [];
			// Calculate the starting block to query the last 10,000 blocks (10 pages of 1000)
			const TOTAL_BLOCKS_TO_QUERY = 10000;
			let currentQueryStartBlock = BigInt(Math.max(0, Number(latestBlock) - (TOTAL_BLOCKS_TO_QUERY - 1)));
			if (currentQueryStartBlock < 0n) currentQueryStartBlock = 0n; // Ensure not negative

			console.log(`Starting log query from block ${currentQueryStartBlock} up to ${latestBlock} (max 10 pages of ${BLOCK_RANGE_LIMIT} blocks).`);

			let pagesFetched = 0;
			const MAX_PAGES = 10;

			while (currentQueryStartBlock <= latestBlock && pagesFetched < MAX_PAGES) {
				let chunkToBlock = currentQueryStartBlock + BigInt(BLOCK_RANGE_LIMIT - 1);
				if (chunkToBlock > latestBlock) {
					chunkToBlock = latestBlock;
				}

				console.log(`Fetching logs for chunk: ${currentQueryStartBlock} to ${chunkToBlock}`);
				try {
					const chunkLogs = await publicClient.getLogs({
						address: FRAME_RECORDER_CONTRACT_ADDRESS,
						event: videoClipUpdatedEventAbi,
						fromBlock: currentQueryStartBlock,
						toBlock: chunkToBlock,
					});

					if (chunkLogs && chunkLogs.length > 0) {
						console.log(`Found ${chunkLogs.length} logs in chunk ${currentQueryStartBlock}-${chunkToBlock}.`);
						// Serialize BigInts for JSON response before concatenating
						const serializableLogs = chunkLogs.map(log => 
							JSON.parse(JSON.stringify(log, (key, value) =>
								typeof value === 'bigint' ? value.toString() : value
							))
						);
						allLogs = allLogs.concat(serializableLogs);
					}
				} catch (chunkError) {
					console.error(`Error fetching logs for chunk ${currentQueryStartBlock}-${chunkToBlock}:`, chunkError.message);
					// Decide if you want to break, continue, or return partial data on chunk error
					// For now, we'll log and continue to try subsequent chunks.
				}
				
				pagesFetched++; // Increment pages fetched for this iteration
				if (chunkToBlock === latestBlock) {
					console.log("Reached latest block in chunk processing.");
					break; 
				}
				currentQueryStartBlock = chunkToBlock + 1n;
			}

			console.log(`Total logs fetched: ${allLogs.length}`);

			const responsePayload = {
				logs: allLogs,
				lastProcessedBlock: latestBlock.toString(),
				totalLogs: allLogs.length,
				source: 'rpc',
				timestamp: new Date().toISOString()
			};

			// Store in KV Cache if available
			if (env.LOG_CACHE) {
				try {
					console.log(`Storing fetched logs in KV cache with TTL ${CACHE_TTL_SECONDS}s. Key: ${CACHE_KEY}`);
					// Use waitUntil to not block the response to the client
					ctx.waitUntil(env.LOG_CACHE.put(CACHE_KEY, JSON.stringify(responsePayload), {
						expirationTtl: CACHE_TTL_SECONDS,
					}));
				} catch (kvWriteError) {
					console.error("Error writing to KV cache:", kvWriteError);
				}
			}

			return new Response(JSON.stringify(responsePayload), {
				headers: {
					...CORS_HEADERS,
					'Content-Type': 'application/json',
					'X-Cache-Status': 'MISS'
				}
			});

		} catch (error) {
			console.error('Error in worker fetch handler:', error);
			return new Response(`Worker error: ${error.message}`, {
				status: 500,
				headers: CORS_HEADERS
			});
		}
	},
};
