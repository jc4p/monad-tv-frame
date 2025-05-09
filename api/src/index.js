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
const RECENT_CACHE_KEY = "monad-grid:all_video_clip_logs_v2"; // Cache for recent/delta updates
const HISTORICAL_CACHE_KEY = "monad-grid:historical_logs_v1"; // Cache populated by backfill script
const CACHE_TTL_SECONDS = 2 * 60; // 2 minutes for the recent cache
const INITIAL_LOOKBACK_BLOCKS = 10000; // For the first fetch if both caches are empty

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

		console.log("Proceeding to fetch logs from RPC (potentially merging historical, recent cache, and new delta)...");

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

			console.log("Fetching latest block number from RPC...");
			const currentRpcLatestBlock = await publicClient.getBlockNumber();
			console.log(`Current RPC latest block number: ${currentRpcLatestBlock}`);

			let baseLogs = [];
			let effectiveCachedUpToBlock = 0n; // The latest block covered by any cache we load
			let queryFromBlock;
			let cacheStatus = 'MISS_FULL_FETCH'; // Default status

			if (env.LOG_CACHE) {
				// 1. Try to load historical logs (long-term, deep history)
				try {
					console.log(`Checking historical KV cache for key: ${HISTORICAL_CACHE_KEY}`);
					const historicalData = await env.LOG_CACHE.get(HISTORICAL_CACHE_KEY, { type: "json" });
					if (historicalData && historicalData.logs && historicalData.fetchedUpToBlock) {
						console.log(`Historical cache hit. Contains ${historicalData.logs.length} logs up to block ${historicalData.fetchedUpToBlock}.`);
						baseLogs = historicalData.logs;
						effectiveCachedUpToBlock = BigInt(historicalData.fetchedUpToBlock);
						cacheStatus = 'HIT_HISTORICAL';
					} else {
						console.log("Historical cache miss or invalid structure.");
					}
				} catch (kvError) {
					console.error("Error reading from Historical KV cache:", kvError);
				}

				// 2. Try to load recent/delta cache and see if it's more up-to-date
				try {
					console.log(`Checking recent KV cache for key: ${RECENT_CACHE_KEY}`);
					const recentCachedResult = await env.LOG_CACHE.get(RECENT_CACHE_KEY, { type: "json" });
					if (recentCachedResult && recentCachedResult.logs && recentCachedResult.cachedUpToBlock) {
						const recentCacheBlockNum = BigInt(recentCachedResult.cachedUpToBlock);
						console.log(`Recent cache hit. Contains ${recentCachedResult.logs.length} logs up to block ${recentCacheBlockNum}.`);
						if (recentCacheBlockNum >= effectiveCachedUpToBlock) { // Use recent cache if it's same or newer
							console.log("Recent cache is fresher or same as historical. Using it as base.");
							baseLogs = recentCachedResult.logs;
							effectiveCachedUpToBlock = recentCacheBlockNum;
							cacheStatus = 'HIT_RECENT'; 
							// If recent cache is fully up to date with RPC, we might return early
							if (effectiveCachedUpToBlock >= currentRpcLatestBlock) {
								console.log("Recent cache is already up-to-date with current RPC latest block. Returning its data.");
								return new Response(JSON.stringify(recentCachedResult), {
									headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Cache-Status': 'HIT_RECENT_UPTODATE' },
								});
							}
						} else {
							console.log("Recent cache is older than historical data; historical data will be prioritized as base.");
						}
					} else {
						console.log("Recent cache miss or invalid structure.");
					}
				} catch (kvError) {
					console.error("Error reading from Recent KV cache:", kvError);
				}
			}

			// 3. Determine queryFromBlock based on loaded caches
			if (effectiveCachedUpToBlock > 0n && currentRpcLatestBlock > effectiveCachedUpToBlock) {
				queryFromBlock = effectiveCachedUpToBlock + 1n;
				console.log(`Delta update determined: Fetching logs from ${queryFromBlock} to ${currentRpcLatestBlock}. Starting with ${baseLogs.length} base logs from cache (${cacheStatus}).`);
			} else if (effectiveCachedUpToBlock > 0n && currentRpcLatestBlock <= effectiveCachedUpToBlock) {
				console.log("All caches are up-to-date with or ahead of RPC latest block. No new logs to fetch from RPC.");
				// Sort baseLogs (could be historical or recent) before returning if no new fetch needed
                baseLogs.sort((a,b) => Number(b.args.timestamp) - Number(a.args.timestamp));
				const payload = { logs: baseLogs, cachedUpToBlock: effectiveCachedUpToBlock.toString(), totalLogs: baseLogs.length, source: cacheStatus, cacheTimestamp: new Date().toISOString() };
				return new Response(JSON.stringify(payload), {
					headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'X-Cache-Status': cacheStatus + '_UPTODATE' },
				});
			} else {
				// Initial fetch (neither historical nor recent cache provided a base or they were empty)
				queryFromBlock = BigInt(Math.max(0, Number(currentRpcLatestBlock) - (INITIAL_LOOKBACK_BLOCKS - 1)));
				if (queryFromBlock < 0n) queryFromBlock = 0n;
				console.log(`Initial fetch (no/old cache): Looking back ${INITIAL_LOOKBACK_BLOCKS} blocks. Querying from ${queryFromBlock} to ${currentRpcLatestBlock}.`);
				baseLogs = []; // Ensure baseLogs is empty for a true initial fetch scenario
				cacheStatus = 'MISS_INITIAL_FETCH';
			}
			
			let newLogsFetched = [];
			let currentChunkStartBlock = queryFromBlock;
			let fetchPerformed = false;

			// Only loop if there are blocks to query
			if (currentChunkStartBlock <= currentRpcLatestBlock) {
				console.log(`Log fetching loop from RPC: from ${currentChunkStartBlock} up to ${currentRpcLatestBlock}.`);
				fetchPerformed = true;
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
			}

			// Merge new logs with baseLogs
			let finalLogs = baseLogs;
			if (fetchPerformed && newLogsFetched.length > 0) {
				console.log(`Merging ${newLogsFetched.length} new logs with ${baseLogs.length} base logs.`);
				finalLogs = baseLogs.concat(newLogsFetched);
				console.log(`Total logs before final sort & dedupe: ${finalLogs.length}`);
			} else if (!fetchPerformed) {
                console.log("No RPC fetch was performed (data likely up-to-date from cache).");
            }

            // Final sort and deduplication of all logs (historical + recent cache + new from RPC)
            const logSignatures = new Set();
            const uniqueCombinedLogs = [];
            // Sort first by timestamp (descending) then block (descending) then logIndex (descending) for stable sort
            finalLogs.sort((a,b) => {
                const tsCompare = Number(b.args.timestamp) - Number(a.args.timestamp);
                if (tsCompare !== 0) return tsCompare;
                const blockCompare = BigInt(b.blockNumber) - BigInt(a.blockNumber);
                if (blockCompare !== 0n) return blockCompare > 0n ? 1 : -1; // BigInt comparison needs care
                return Number(b.logIndex) - Number(a.logIndex);
            });

            for (const log of finalLogs) {
                const sig = `${log.transactionHash}-${log.logIndex}`;
                if (!logSignatures.has(sig)) {
                    uniqueCombinedLogs.push(log);
                    logSignatures.add(sig);
                }
            }
			console.log(`Total unique logs after final sort & deduplication: ${uniqueCombinedLogs.length}`);

			const responsePayload = {
				logs: uniqueCombinedLogs, 
				cachedUpToBlock: currentRpcLatestBlock.toString(), 
				totalLogs: uniqueCombinedLogs.length,
				source: fetchPerformed ? (effectiveCachedUpToBlock > 0n ? 'rpc_delta_update' : 'rpc_initial_fetch') : cacheStatus,
				cacheTimestamp: new Date().toISOString()
			};

			// Store/Update the "recent" cache (CACHE_KEY) with the fully merged and up-to-date data
			if (env.LOG_CACHE) {
				try {
					console.log(`Storing/Updating recent logs in KV cache with TTL ${CACHE_TTL_SECONDS}s. Key: ${RECENT_CACHE_KEY}`);
					ctx.waitUntil(env.LOG_CACHE.put(RECENT_CACHE_KEY, JSON.stringify(responsePayload), {
						expirationTtl: CACHE_TTL_SECONDS,
					}));
				} catch (kvWriteError) {
					console.error("Error writing to recent KV cache:", kvWriteError);
				}
			}

			return new Response(JSON.stringify(responsePayload), {
				headers: {
					...CORS_HEADERS,
					'Content-Type': 'application/json',
					'X-Cache-Status': fetchPerformed ? (effectiveCachedUpToBlock > 0n ? 'MISS_DELTA' : 'MISS_INITIAL') : cacheStatus.replace('HIT', 'HIT_SERVED')
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
