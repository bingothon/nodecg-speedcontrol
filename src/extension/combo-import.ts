import {
    HoraroSchedule,
    ImportOptions,
    ImportOptionsSanitized,
    OengusLine,
    OengusMarathon,
    OengusSchedule,
    RunData,
    RunDataPlayer,
    RunDataTeam,
} from '@nodecg-speedcontrol/types'; // eslint-disable-line object-curly-newline, max-len
import crypto from 'crypto';
import needle, {NeedleResponse} from 'needle';
import {mapSeries} from 'p-iteration';
import parseDuration from 'parse-duration';
import {v4 as uuid} from 'uuid';
import {searchForTwitchGame, searchForUserDataMultiple} from './srcom-api';
import {verifyTwitchDir} from './twitch-api';
import {
    checkGameAgainstIgnoreList,
    getTwitchUserFromURL,
    msToTimeStr,
    parseMarkdown,
    processAck,
    to,
} from './util/helpers'; // eslint-disable-line object-curly-newline, max-len
import {get as ncgGet} from './util/nodecg';
import {defaultSetupTime, horaroImportStatus, oengusImportStatus, runDataArray,} from './util/replicants';


const nodecg = ncgGet();
const config = nodecg.bundleConfig;
const scheduleDataCache: { [k: string]: HoraroSchedule } = {};

/**
 * Resets the replicant's values to default.
 */
function resetImportStatus(): void {
    horaroImportStatus.value.importing = false;
    horaroImportStatus.value.item = 0;
    horaroImportStatus.value.total = 0;
    nodecg.log.debug('[Combo Import] Horaro Import status restored to default');
}

function resetOengusImportStatus(): void {
    oengusImportStatus.value.importing = false;
    oengusImportStatus.value.item = 0;
    oengusImportStatus.value.total = 0;
    nodecg.log.debug('[Combo Import] Oengus Import status restored to default');
}

/**
 * Typechecking
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isOengusSchedule(source: any): source is OengusSchedule {
    return (typeof source.id === 'number' && source.lines !== undefined);
}

function checkValidOengusLine(line: OengusLine) {
    return (
        line !== undefined &&
        line !== null &&
        typeof line.game === 'string' &&
        Array.isArray(line.runners)
    );
}

/**
 * Make a GET request to Oengus API.
 * @param endpoint Oengus API endpoint you want to access.
 */
async function get(endpoint: string): Promise<NeedleResponse> {
    try {
        nodecg.log.debug(`[Oengus Import] API request processing on ${endpoint}`);
        const resp = await needle(
            'get',
            `https://${config.oengus.useSandbox ? 'sandbox.' : ''
            }oengus.io/api/v2${endpoint}`,
            null,
            {
                headers: {
                    'User-Agent': 'nodecg-speedcontrol',
                    Accept: 'application/json',
                    'oengus-version': '2',
                },
            }
        );
        if (resp.statusCode !== 200) {
            throw new Error(
                `Status Code: ${resp.statusCode} - Body: ${JSON.stringify(resp.body)}`
            );
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-ignore: parser exists but isn't in the typings
        } else if (resp.parser !== 'json') {
            throw new Error('Response was not JSON');
        }
        nodecg.log.debug(`[Oengus Import] API request successful on ${endpoint}`);
        return resp;
    } catch (err) {
        nodecg.log.debug(`[Oengus Import] API request error on ${endpoint}:`, err);
        throw err;
    }
}

/**
 * Import schedule data in from Oengus.
 * @param marathonShort Oengus' marathon shortname you want to import.
 * @param useJapanese If you want to use usernameJapanese from the user data.
 */

async function importOengusPlayers(marathonShort: string, scheduleSlug: string, useJapanese: boolean) {
    try {
        oengusImportStatus.value.importing = true;
        const scheduleResp = await get(`/marathons/${marathonShort}/schedules/for-slug/${scheduleSlug}`);
        
        if (!isOengusSchedule(scheduleResp.body)) {
            throw new Error('Did not receive schedule data correctly');
        }
        
        // Ensure oengusLines is always a defined array and only contains valid lines
        const oengusLines = scheduleResp.body.lines?.filter(checkValidOengusLine);
        
        if (!oengusLines || oengusLines.length === 0) {
            throw new Error('No schedule data found');
        }
        
        let playersArray = await mapSeries(
            oengusLines
                .filter((line: OengusLine | undefined) => line && line.game && !checkGameAgainstIgnoreList(line.game, 'oengus'))
                .map((line) => line as OengusLine), // Narrow type after filter check
            async (line: OengusLine, index: number, arr: any) => {
                nodecg.log.info(line);
                oengusImportStatus.value.item = index + 1;
                oengusImportStatus.value.total = arr.length;
                
                const profiles = (line.runners || [])
                    .map(runner => runner.profile)  // Extract the profile from each runner
                    .filter((profile) => profile !== undefined);  // Filter out undefined profiles
                
                let players = await mapSeries(profiles, async (profile) => {
                    if (!profile) {
                        // Return a placeholder player object if profile is null or undefined
                        return {
                            name: 'Unknown',
                            displayName: 'Unknown',
                            social: {
                                twitch: 'undefined',
                            },
                            country: undefined,
                            pronouns: undefined,
                            customData: {},
                        };
                    }
                    
                    const playerTwitch = profile.connections?.find((c) => c.platform === 'TWITCH')?.username || 'undefined';
                    const playerPronouns = Array.isArray(profile.pronouns)
                        ? profile.pronouns
                        : (typeof profile.pronouns === 'string' ? (profile.pronouns as String).split(',') : undefined);
                    
                    const player = {
                        name: profile.username || 'undefined',
                        displayName: profile.displayName || profile.username || 'undefined',
                        social: {
                            twitch: playerTwitch !== 'undefined' ? playerTwitch : 'undefined',
                        },
                        country: profile.country?.toLowerCase() || undefined,
                        pronouns: playerPronouns?.join(', ') || undefined,
                        customData: {},
                    };
                    
                    if (!config.oengus.disableSpeedrunComLookup) {
                        const playerTwitter = profile.connections?.find((c) => c.platform === 'TWITTER')?.username;
                        const playerSrcom = profile.connections?.find((c) => c.platform === 'SPEEDRUNCOM')?.username;
                        
                        const data = await searchForUserDataMultiple(
                            {type: 'srcom', val: playerSrcom},
                            {type: 'twitch', val: playerTwitch},
                            {type: 'twitter', val: playerTwitter},
                            {type: 'name', val: profile.username}
                        );
                        
                        if (data) {
                            if (playerTwitch === 'undefined') {
                                const tURL = data.twitch?.uri;
                                player.social.twitch = getTwitchUserFromURL(tURL) || 'undefined';
                            }
                            player.country = player.country || data.location?.country.code?.toLowerCase();
                            player.pronouns = player.pronouns || data.pronouns?.toLowerCase();
                        }
                    }
                    
                    return player;
                });
                return players;
            }
        );
        return playersArray.flat();
    } catch (err) {
        resetOengusImportStatus();
        resetImportStatus();
        throw err;
    }
}

/**
 * Generates a hash based on the contents of the string based run data from Horaro.
 * @param colData Array of strings (or nulls), obtained from the Horaro JSON data.
 */
function generateRunHash(colData: (string | null)[]): string {
    return crypto.createHash('sha1').update(colData.join(), 'utf8').digest('hex');
}

/**
 * Load schedule data in from Horaro, store in a temporary cache and return it.
 * @param url URL of Horaro schedule.
 * @param dashID UUID of dashboard element, generated on panel load and passed here.
 */
async function loadSchedule(
    url: string,
    dashID: string
): Promise<HoraroSchedule> {
    try {
        let jsonURL = `${url}.json`;
        if (url.match(/\?key=/)) {
            // If schedule URL has a key in it, extract it correctly.
            const urlMatch = (url.match(/(.*?)(?=(\?key=))/) as RegExpMatchArray)[0];
            const keyMatch = (
                url.match(/(?<=(\?key=))(.*?)$/) as RegExpMatchArray
            )[0];
            jsonURL = `${urlMatch}.json?key=${keyMatch}`;
        }
        const resp = await needle('get', encodeURI(jsonURL));
        if (resp.statusCode !== 200) {
            throw new Error(`HTTP status code was ${resp.statusCode}`);
        }
        scheduleDataCache[dashID] = resp.body;
        nodecg.log.debug('[Horaro Import] Schedule successfully loaded');
        return resp.body;
    } catch (err) {
        nodecg.log.debug('[Horaro Import] Schedule could not be loaded:', err);
        throw err;
    }
}

/**
 * Imports schedule data loaded in above function.
 * @param optsO Options on how the schedule data should be parsed, including column numbers.
 * @param dashID UUID of dashboard element, generated on panel load and passed here.
 * @param oengusShort shortName of oengus Marathon to look up players
 * @param useJPOengusNames if using JP usernames for Oengus
 */
async function importSchedule(optsO: ImportOptions, dashID: string, oengusShort: string, scheduleSlug: string, useJPOengusNames: boolean): Promise<void> {
    try {
        horaroImportStatus.value.importing = true;
        const data = scheduleDataCache[dashID];
        const runItems = data.schedule.items;
        const setupTime = data.schedule.setup_t;
        defaultSetupTime.value = setupTime;
        
        // Sanitizing import option inputs with this "mess".
        const opts: ImportOptionsSanitized = {
            columns: {
                game: (optsO.columns.game === null) ? -1 : optsO.columns.game,
                gameTwitch: (optsO.columns.gameTwitch === null) ? -1 : optsO.columns.gameTwitch,
                category: (optsO.columns.category === null) ? -1 : optsO.columns.category,
                system: (optsO.columns.system === null) ? -1 : optsO.columns.system,
                region: (optsO.columns.region === null) ? -1 : optsO.columns.region,
                release: (optsO.columns.release === null) ? -1 : optsO.columns.release,
                player: (optsO.columns.player === null) ? -1 : optsO.columns.player,
                externalID: (optsO.columns.externalID === null) ? -1 : optsO.columns.externalID,
                custom: {},
            },
            split: optsO.split,
        };
        Object.keys(optsO.columns.custom).forEach((col) => {
            const val = optsO.columns.custom[col];
            opts.columns.custom[col] = (val === null) ? -1 : val;
        });
        
        const externalIDsSeen: string[] = [];
        // Filtering out any games on the ignore list before processing them all.
        const newRunDataArray = await mapSeries(runItems.filter((run) => (
            !checkGameAgainstIgnoreList(run.data[opts.columns.game], 'horaro')
        )), async (run: any, index: number, arr: any) => {
            horaroImportStatus.value.item = index + 1;
            horaroImportStatus.value.total = arr.length;
            
            // If a run with the same external ID exists already, use the same UUID.
            // This will only work for the first instance of an external ID; for hashes, this is usually
            // only an issue if the same "run" happens twice in a schedule (for example a Setup block),
            // and for actual defined IDs from a column should never happen, but idiot proofing it.
            const externalID = run.data[opts.columns.externalID] || generateRunHash(run.data);
            let matchingOldRun;
            if (externalIDsSeen.indexOf(externalID) === -1) {
                matchingOldRun = runDataArray.value.find((oldRun: any) => oldRun.externalID === externalID);
                externalIDsSeen.push(externalID);
            }
            
            const runData: RunData = {
                teams: [],
                customData: {},
                id: matchingOldRun?.id || uuid(),
                externalID,
            };
            
            // General Run Data
            runData.game = parseMarkdown(run.data[opts.columns.game]).str;
            runData.system = parseMarkdown(run.data[opts.columns.system]).str;
            runData.category = parseMarkdown(run.data[opts.columns.category]).str;
            runData.region = parseMarkdown(run.data[opts.columns.region]).str;
            runData.release = parseMarkdown(run.data[opts.columns.release]).str;
            
            // Attempts to find the correct Twitch game directory.
            const game = parseMarkdown(run.data[opts.columns.game]);
            let gameTwitch = parseMarkdown(run.data[opts.columns.gameTwitch]).str;
            // TODO: Don't even try to look up Twitch directory if we can't verify it!
            let srcomGameTwitch;
            if (!(config.schedule || config.horaro).disableSpeedrunComLookup && !gameTwitch) {
                if (game.url && game.url.includes('speedrun.com')) {
                    const gameAbbr = game.url
                        .split('speedrun.com/')[game.url.split('speedrun.com/').length - 1]
                        .split('/')[0]
                        .split('#')[0];
                    [, srcomGameTwitch] = await to(searchForTwitchGame(gameAbbr, true));
                }
                if (!srcomGameTwitch && game.str) {
                    [, srcomGameTwitch] = await to(searchForTwitchGame(game.str));
                }
            }
            let gameCover = '';
            // Verify some game directory supplied exists on Twitch.
            for (const str of [gameTwitch, srcomGameTwitch, game.str]) {
                if (str) {
                    const twitchDirectoryResult = await to(verifyTwitchDir(gameTwitch || str));
                    gameCover = twitchDirectoryResult[1]?.gameCover || 'undefined';
                    if (gameTwitch) {
                        break; // If a directory was successfully found, stop loop early.
                    }
                }
            }
            runData.gameTwitch = gameTwitch;
            runData.customData.gameCover = gameCover;
            
            // Scheduled Date/Time
            runData.scheduledS = run.scheduled_t;
            runData.scheduled = run.scheduled;
            
            // Estimate
            runData.estimateS = run.length_t;
            runData.estimate = msToTimeStr(run.length_t * 1000);
            
            // Setup Time
            let runSetupTime = setupTime * 1000;
            if (run.options && run.options.setup) {
                const duration = parseDuration(run.options.setup);
                if (duration > 0) {
                    runSetupTime = duration;
                }
            }
            runData.setupTime = msToTimeStr(runSetupTime);
            runData.setupTimeS = runSetupTime / 1000;
            
            // Custom Data
            Object.keys(opts.columns.custom).forEach((col) => {
                const customDataConfig = config.customData?.run
                    || config.schedule?.customData
                    || config.horaro.customData;
                if (!customDataConfig) {
                    return;
                }
                const colSetting = customDataConfig.find((setting: any) => setting.key === col);
                if (!colSetting) {
                    return;
                }
                const colData = run.data[opts.columns.custom[col]];
                const str = (!colSetting.ignoreMarkdown) ? parseMarkdown(colData).str : colData;
                if (str) {
                    runData.customData[col] = str;
                }
            });
            
            const allOengusPlayers = await importOengusPlayers(oengusShort, scheduleSlug, useJPOengusNames);
            
            // Players
            const playerList = run.data[opts.columns.player];
            if (playerList) {
                // Mapping team string into something more manageable.
                const teamSplittingRegex = [
                    /\s+vs\.?\s+/, // vs/vs.
                    /\s*,\s*/, // Comma (,)
                ];
                const teamsRaw = await mapSeries(
                    playerList.split(teamSplittingRegex[opts.split]),
                    (team: any) => {
                        const nameMatch = team.match(/^(.+)(?=:\s)/);
                        return {
                            name: (nameMatch) ? nameMatch[0] : undefined,
                            players: (opts.split === 0)
                                ? team.replace(/^(.+)(:\s)/, '').split(/\s*,\s*/)
                                : [team.replace(/^(.+)(:\s)/, '')],
                        };
                    },
                );
                
                // Mapping team information from above into needed format.
                runData.teams = await mapSeries(
                    teamsRaw,
                    async (rawTeam: any) => {
                        const team: RunDataTeam = {
                            id: uuid(),
                            name: parseMarkdown(rawTeam.name).str,
                            players: [],
                        };
                        
                        // Mapping player information into needed format.
                        team.players = await mapSeries(
                            rawTeam.players,
                            async (rawPlayer: any) => {
                                const {str, url} = parseMarkdown(rawPlayer);
                                const twitchUsername = getTwitchUserFromURL(url);
                                
                                let oengusPlayer = allOengusPlayers.find((player: {
                                    name: string,
                                    displayName: string
                                }) => {
                                    return player.name === str || player.displayName === str;
                                });
                                const player: RunDataPlayer = {
                                    name: oengusPlayer?.displayName || str || '',
                                    id: uuid(),
                                    teamID: team.id,
                                    social: {
                                        twitch: oengusPlayer?.social.twitch || twitchUsername,
                                    },
                                    country: oengusPlayer?.country || undefined,
                                    pronouns: oengusPlayer?.pronouns || undefined,
                                    customData: {},
                                };
                                if (!(config.schedule || config.horaro).disableSpeedrunComLookup) {
                                    const sData = await searchForUserDataMultiple(
                                        {type: 'twitch', val: twitchUsername},
                                        {type: 'name', val: str},
                                        {type: 'twitch', val: str},
                                        {type: 'twitter', val: str},
                                    );
                                    if (sData) {
                                        // Always favour the supplied Twitch username from schedule if available.
                                        if (!twitchUsername) {
                                            const tURL = (sData.twitch && sData.twitch.uri)
                                                ? sData.twitch.uri : undefined;
                                            player.social.twitch = getTwitchUserFromURL(tURL);
                                        }
                                        if (!player.country) {
                                            player.country = sData.location?.country.code || undefined;
                                        }
                                        if (!player.pronouns) {
                                            player.pronouns = sData.pronouns?.toLowerCase() || undefined;
                                        }
                                    }
                                }
                                return player;
                            },
                        );
                        
                        return team;
                    },
                );
            }
            
            nodecg.log.debug(`[Combo Import] Successfully imported ${index + 1}/${runItems.length}`);
            return runData;
        });
        
        runDataArray.value = newRunDataArray;
        resetOengusImportStatus();
        resetImportStatus();
    } catch (err) {
        resetImportStatus();
        throw err;
    }
}

nodecg.listenFor('loadComboSchedule', (data: any, ack: any) => {
    loadSchedule(data.url, data.dashID)
        .then((data_) => processAck(ack, null, data_))
        .catch((err) => processAck(ack, err));
});

nodecg.listenFor('importComboSchedule', async (data: any, ack: any) => {
    try {
        if (horaroImportStatus.value.importing) {
            throw new Error('Already importing schedule');
        }
        nodecg.log.info('[Combo Import] Started importing schedule');
        await importSchedule(
            data.opts,
            data.dashID,
            data.oengusShort,
            data.scheduleSlug,
            data.useJPOengusNames
        );
        nodecg.log.info('[Combo Import] Successfully imported schedule');
        processAck(ack, null);
    } catch (err) {
        nodecg.log.warn('[Combo Import] Error importing schedule:', err);
        processAck(ack, err);
    }
});
