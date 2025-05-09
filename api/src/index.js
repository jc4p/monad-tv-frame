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
const CACHE_KEY = "monad-grid:all_video_clip_logs_v2"; // Incremented version for new cache structure
const CACHE_TTL_SECONDS = 2 * 60; // 2 minutes
const INITIAL_LOOKBACK_BLOCKS = 10000; // Increased for a deeper initial fetch

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
				const cachedResult = await env.LOG_CACHE.get(CACHE_KEY, { type: "json" });
				
				if (cachedResult && cachedResult.logs && cachedResult.cachedUpToBlock) {
					console.log(`Cache hit. Cached up to block ${cachedResult.cachedUpToBlock}. Cache timestamp: ${cachedResult.cacheTimestamp}`);
					
					// We will still fetch new logs beyond cachedUpToBlock and merge if needed
					// This ensures we serve fresh data if available, while leveraging the cache for older data.
					// The main TTL on put() handles full refresh. This logic is for delta updates within TTL.
					
					// Fall through to fetch new logs and merge, using cachedResult as base for `fromBlock`
				} else {
					console.log("Cache miss or invalid cache structure.");
					// proceed to full fetch, cachedResult will be null
				}
			} catch (kvError) {
				console.error("Error reading from KV cache:", kvError);
				// Proceed to fetch from origin
			}
		} else {
			console.warn("LOG_CACHE KV namespace not bound or available.");
		}

		console.log("Proceeding to fetch logs from RPC (full or delta)...");

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
			const currentRpcLatestBlock = await publicClient.getBlockNumber();
			console.log(`Current RPC latest block number: ${currentRpcLatestBlock}`);

			let allLogs = [];
			let queryFromBlock;
			let isDeltaUpdate = false;

			// Try to get cached data again, in case it was fetched by a concurrent request or to re-evaluate
			// This ensures we use the most up-to-date cache info before deciding the fetch range.
			const potentiallyUpdatedCachedResult = env.LOG_CACHE ? await env.LOG_CACHE.get(CACHE_KEY, { type: "json" }) : null;

			if (potentiallyUpdatedCachedResult && potentiallyUpdatedCachedResult.logs && potentiallyUpdatedCachedResult.cachedUpToBlock) {
				const cachedUpToBlockNum = BigInt(potentiallyUpdatedCachedResult.cachedUpToBlock);
				if (currentRpcLatestBlock > cachedUpToBlockNum) {
					queryFromBlock = cachedUpToBlockNum + 1n;
					allLogs = potentiallyUpdatedCachedResult.logs; // Start with existing cached logs
					isDeltaUpdate = true;
					console.log(`Delta update: Fetching logs from ${queryFromBlock} to ${currentRpcLatestBlock}. Starting with ${allLogs.length} cached logs.`);
				} else {
					// Cache is up-to-date or ahead (e.g. RPC node slightly behind)
					console.log("Cache is already up-to-date with current RPC latest block. Returning cached data.");
					return new Response(JSON.stringify(potentiallyUpdatedCachedResult), {
						headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Cache-Status': 'HIT_UPTODATE' },
					});
				}
			} else {
				// Initial fetch or cache was invalid
				queryFromBlock = BigInt(Math.max(0, Number(currentRpcLatestBlock) - (INITIAL_LOOKBACK_BLOCKS - 1)));
				if (queryFromBlock < 0n) queryFromBlock = 0n;
				console.log(`Initial fetch: Looking back ${INITIAL_LOOKBACK_BLOCKS} blocks. Querying from ${queryFromBlock} to ${currentRpcLatestBlock}.`);
			}
			
			let newLogsFetched = [];
			let currentChunkStartBlock = queryFromBlock;

			console.log(`Log fetching loop: from ${currentChunkStartBlock} up to ${currentRpcLatestBlock}.`);

			while (currentChunkStartBlock <= currentRpcLatestBlock) {
				let chunkToBlock = currentChunkStartBlock + BigInt(BLOCK_RANGE_LIMIT - 1);
				if (chunkToBlock > currentRpcLatestBlock) {
					chunkToBlock = currentRpcLatestBlock;
				}

				console.log(`Fetching logs for chunk: ${currentChunkStartBlock} to ${chunkToBlock}`);
				try {
					const chunkLogs = await publicClient.getLogs({
						address: FRAME_RECORDER_CONTRACT_ADDRESS,
						event: videoClipUpdatedEventAbi,
						fromBlock: currentChunkStartBlock,
						toBlock: chunkToBlock,
					});

					if (chunkLogs && chunkLogs.length > 0) {
						console.log(`Found ${chunkLogs.length} logs in chunk ${currentChunkStartBlock}-${chunkToBlock}.`);
						const serializableLogs = chunkLogs.map(log => 
							JSON.parse(JSON.stringify(log, (key, value) =>
								typeof value === 'bigint' ? value.toString() : value
							))
						);
						newLogsFetched = newLogsFetched.concat(serializableLogs);
					}
				} catch (chunkError) {
					console.error(`Error fetching logs for chunk ${currentChunkStartBlock}-${chunkToBlock}:`, chunkError.message);
				}
				
				if (chunkToBlock === currentRpcLatestBlock) {
					console.log("Reached current RPC latest block in chunk processing.");
					break; 
				}
				currentChunkStartBlock = chunkToBlock + 1n;
			}

			// Merge new logs with existing cached logs if it was a delta update
			if (isDeltaUpdate && newLogsFetched.length > 0) {
				console.log(`Merging ${newLogsFetched.length} new logs with ${allLogs.length} cached logs.`);
				// A simple concat and re-sort is robust for ensuring order and handling potential (though unlikely) overlaps
				// if log sources were different or block numbers had minor discrepancies.
				// For now, newLogsFetched are inherently newer, so simple concat might be okay if sorted later.
				// However, to ensure correctness and handle potential re-orgs or overlaps if any source provides slightly older "new" logs:
				const combinedForSort = allLogs.concat(newLogsFetched);
                const logSignatures = new Set();
                const uniqueCombined = [];
                // Deduplicate based on transactionHash and logIndex, prioritizing newer if timestamps differ for same sig (unlikely for pure new fetch)
                // For simplicity, let's sort first, then deduplicate by signature, keeping the first seen (which will be newest due to sort)
                combinedForSort.sort((a,b) => Number(b.args.timestamp) - Number(a.args.timestamp));
                for (const log of combinedForSort) {
                    const sig = `${log.transactionHash}-${log.logIndex}`;
                    if (!logSignatures.has(sig)) {
                        uniqueCombined.push(log);
                        logSignatures.add(sig);
                    }
                }
				allLogs = uniqueCombined;
				console.log(`Total logs after delta merge and deduplication: ${allLogs.length}`);
			} else if (!isDeltaUpdate) {
				allLogs = newLogsFetched; // This was an initial fetch
                // Sort initial fetch as well
                allLogs.sort((a,b) => Number(b.args.timestamp) - Number(a.args.timestamp));
			}
            // If isDeltaUpdate but newLogsFetched.length is 0, allLogs remains the original cached logs.

			// console.log(`Total logs prepared for response: ${allLogs.length}`); // Already logged after merge/set

			const responsePayload = {
				logs: allLogs, // these are now sorted newest first
				cachedUpToBlock: currentRpcLatestBlock.toString(), // Cache up to the block we queried
				totalLogs: allLogs.length,
				source: isDeltaUpdate ? 'rpc_delta_update' : 'rpc_initial_fetch',
				cacheTimestamp: new Date().toISOString()
			};

			// Store/Update in KV Cache if available
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
