// An adapter is a module exporting `async fetchStatuses(options) -> [{ station, status, note?, updatedAt? }]`.
// Register new sources (CSP, COtrip, Drivewyze...) here once a real feed is available.
import * as file from './file.js';
import * as url from './url.js';

export const adapters = { file, url };
