export interface SetDef {
  id: string;       // slug, matches pull-rates-{id}.json
  name: string;     // display name
  groupId: number;  // TCGCSV group ID
}

/**
 * All Pokemon sets supported by this tool (12 most recent SV + ME era sets).
 * `groupId` is the TCGCSV group identifier — find new IDs at:
 *   https://tcgcsv.com/tcgplayer/3/groups  (3 = Pokemon category)
 * `id` must match the pull-rates config filename: config/pull-rates-{id}.json
 * To add a new set: create the config file and add an entry here.
 */
export const SUPPORTED_SETS: SetDef[] = [
  { id: '151',                      name: 'Scarlet & Violet 151',       groupId: 23237 },
  { id: 'paldean-fates',            name: 'Paldean Fates',              groupId: 23353 },
  { id: 'shrouded-fable',           name: 'Shrouded Fable',             groupId: 23529 },
  { id: 'stellar-crown',            name: 'Stellar Crown',              groupId: 23537 },
  { id: 'surging-sparks',           name: 'Surging Sparks',             groupId: 23651 },
  { id: 'prismatic-evolutions',     name: 'Prismatic Evolutions',       groupId: 23821 },
  { id: 'journey-together',         name: 'Journey Together',           groupId: 24073 },
  { id: 'destined-rivals',          name: 'Destined Rivals',            groupId: 24269 },
  { id: 'mega-evolution',           name: 'Mega Evolution',             groupId: 24380 },
  { id: 'phantasmal-flames',        name: 'Phantasmal Flames',          groupId: 24448 },
  { id: 'ascended-heroes',          name: 'Ascended Heroes',            groupId: 24541 },
  { id: 'perfect-order',            name: 'Perfect Order',              groupId: 24587 },
  { id: 'chaos-rising',             name: 'Chaos Rising',               groupId: 24655 },
];

/** The set shown by default when the web app loads — update to the latest released set. */
export const DEFAULT_SET_ID = 'chaos-rising';
