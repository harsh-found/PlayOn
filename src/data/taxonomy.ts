/**
 * Lazy-initialized, prototype-safe sports taxonomy, O(1) token classifiers, team aliases, and clusters.
 * Zero heavy parsing at module import time for minimal workerd cold-boot latency.
 */

export interface SportMatchEntry { sport: string; rank: number; }
export interface TournamentCluster {
  canonicalKey: string; displayName: string; sportCategory: string;
  kind: "channel" | "show" | "session"; splitBySession?: boolean; regex: RegExp;
}
export interface ProviderDescriptor { readonly key: string; readonly id: string; readonly name: string; }

export interface TaxonomyTables {
  teamAliases: Record<string, string>;
  contextualTeams: Record<string, Record<string, string>>;
  sportUni: Map<string, SportMatchEntry>;
  sportBi: Map<string, SportMatchEntry>;
  sportTri: Map<string, SportMatchEntry>;
  sportBiFirst: Set<string>;
  sportTriFirst: Set<string>;
  clusters: TournamentCluster[];
  clusterTriggers: Map<string, number[]>;
  cricketNations: Set<string>;
  sportFilterAliases: Record<string, string>;
}

const kvDict = (spec: string): Record<string, string> => {
  const m: Record<string, string> = Object.create(null);
  for (const r of spec.split(";")) { const i = r.indexOf("="); if (i > 0) m[r.slice(0, i)] = r.slice(i + 1); }
  return m;
};

function parseAliases(spec: string, lowercaseKeys = true): Record<string, string> {
  const map: Record<string, string> = Object.create(null);
  for (const row of spec.split(";")) {
    if (!row) continue;
    const eq = row.indexOf("="), canonical = eq === -1 ? row : row.slice(0, eq);
    if (lowercaseKeys) map[canonical.toLowerCase()] = canonical;
    if (eq !== -1) for (const alias of row.slice(eq + 1).split("|")) if (alias) map[alias] = canonical;
  }
  return map;
}

export const PROVIDERS: ReadonlyArray<ProviderDescriptor> = [
  { key: "sportzx", id: "cnc_SportzXLiveEvents_tv", name: "SportzX" },
  { key: "playztv", id: "cnc_PlayZTVLiveEvents_tv", name: "PlayZ TV" },
  { key: "livxow", id: "cnc_LivXowLiveEvents_tv", name: "LivXow" },
  { key: "sktech", id: "cnc_SKTechLiveEvents_tv", name: "SKTech" },
  { key: "playfy", id: "cnc_PlayFyLiveEvents_tv", name: "PlayFy" },
  { key: "cricify", id: "cnc_CricifyLiveEvents_tv", name: "Cricify" },
];

export const PROVIDER_NAME_BY_KEY: Record<string, string> = kvDict("sportzx=SportzX;playztv=PlayZ TV;livxow=LivXow;sktech=SKTech;playfy=PlayFy;cricify=Cricify");

export const SPORT_LABELS: Record<string, string> = kvDict(
  "cricket=Cricket;football=Football;motorsport=Motorsport;combat=Combat Sports;tennis=Tennis;basketball=Basketball;hockey=Ice Hockey;american_football=American Football;rugby=Rugby;table_tennis=Table Tennis;volleyball=Volleyball;golf=Golf;athletics=Athletics;badminton=Badminton;kabaddi=Kabaddi;darts=Darts;snooker=Snooker;cycling=Cycling"
);

export const CANONICAL_SPORTS: ReadonlyArray<string> = Object.keys(SPORT_LABELS);

const TEAM_ALIAS_SPEC =
  "India=ind;Australia=aus;England=eng;Pakistan=pak;New Zealand=nz|nzl;South Africa=sa|rsa;Sri Lanka=sl|sri;" +
  "Bangladesh=ban|bd;West Indies=wi|windies;Afghanistan=afg;Zimbabwe=zim;Ireland=ire|irl;Scotland=sco;" +
  "Netherlands=ned|nld;Nepal=nep;United Arab Emirates=uae;Namibia=nam;Oman=omn|oma|omna;Canada=can;" +
  "USA=united states|us;Thailand=tha;Papua New Guinea=png;Uganda=uga;Kenya=ken;Hong Kong=hkg|hk;Malaysia=mas;" +
  "Kuwait=kuw;Qatar=qat;Bahrain=bhr;Singapore=sgp|sin;Bermuda=ber;Jersey=jer;" +
  "Congo=congo republic|republic of congo;Bosnia and Herzegovina=bosnia & herzegovina;" +
  "Côte d'Ivoire=ivory coast|cote d'ivoire;Türkiye=turkey|turkiye;" +
  "Royal Challengers Bengaluru=rcb|royal challengers bangalore;Chennai Super Kings=csk;Mumbai Indians=mi;" +
  "Kolkata Knight Riders=kkr;Sunrisers Hyderabad=srh;Delhi Capitals=dc;Punjab Kings=pbks|kxip;" +
  "Rajasthan Royals=rr;Gujarat Titans=gt;Lucknow Super Giants=lsg;" +
  "Manchester United=man utd|man united|mufc|man. united|man. utd;Manchester City=man city|mcfc|man. city;" +
  "Tottenham Hotspur=tottenham|spurs;Bayern Munich=bayern|fc bayern|bayern munchen|bayern münchen;" +
  "Borussia Dortmund=dortmund|bvb;Barcelona=barca|barça|futbol club barcelona|fútbol club barcelona;" +
  "Real Madrid=real madrid cf;Atlético Madrid=atletico madrid|atleti|atletico;Paris Saint-Germain=psg|paris sg;" +
  "Inter=inter milan|internazionale|fc inter;Milan=ac milan;Juventus=juve;Wolverhampton Wanderers=wolves;" +
  "Newcastle United=newcastle;West Ham United=west ham;Brighton & Hove Albion=brighton;" +
  "Nottingham Forest=nottm forest|nott'm forest;Leicester City=leicester;Calvo Sotelo Puertollano=cs puertollano;" +
  "Albacete=albacete balompie|albacete balompié;Navalcarnero=cda navalcarnero;" +
  "Tarancón=cd tarancon|cd tarancón|tarancon;Levante=levante ud;Austria Wien=fk austria wien;" +
  "Wolfsburg=vfl wolfsburg;Union Berlin=1. fc union berlin|fc union berlin;" +
  "Philadelphia 76ers=76ers|sixers;Toronto Raptors=raptors;Los Angeles Lakers=lakers|la lakers;" +
  "Golden State Warriors=warriors|gsw;Boston Celtics=celtics;New York Knicks=knicks;Chicago Bulls=bulls;" +
  "Milwaukee Bucks=bucks;Denver Nuggets=nuggets;Los Angeles Clippers=clippers|la clippers;" +
  "Memphis Grizzlies=grizzlies;New Orleans Pelicans=pelicans;San Antonio Spurs=sa spurs;Utah Jazz=jazz;" +
  "Indiana Pacers=pacers;Cleveland Cavaliers=cavaliers|cavs;Brooklyn Nets=nets;Orlando Magic=magic;" +
  "Houston Rockets=rockets;Washington Wizards=wizards;Detroit Pistons=pistons;" +
  "Minnesota Timberwolves=timberwolves|wolves nba;Dallas Mavericks=mavericks|mavs;Phoenix Suns=suns;" +
  "Charlotte Hornets=hornets;Portland Trail Blazers=trail blazers|blazers;Miami Heat=heat;" +
  "Oklahoma City Thunder=okc thunder|thunder;Atlanta Hawks=hawks;" +
  "Boston Bruins=bruins;Montréal Canadiens=canadiens|montreal canadiens;Columbus Blue Jackets=blue jackets;" +
  "Tampa Bay Lightning=lightning;Detroit Red Wings=red wings;New Jersey Devils=devils;" +
  "Washington Capitals=capitals;Toronto Maple Leafs=maple leafs;Minnesota Wild=wild;" +
  "Chicago Blackhawks=blackhawks;Buffalo Sabres=sabres;Seattle Kraken=kraken;Utah Mammoth=mammoth;" +
  "St. Louis Blues=blues;New York Islanders=islanders;Anaheim Ducks=ducks;Nashville Predators=predators;" +
  "San Jose Sharks=sharks;Pittsburgh Penguins=penguins;Vancouver Canucks=canucks;Calgary Flames=flames;" +
  "Vegas Golden Knights=golden knights;Colorado Avalanche=avalanche;Ottawa Senators=senators;" +
  "Philadelphia Flyers=flyers;Edmonton Oilers=oilers;" +
  "Washington Commanders=commanders;San Francisco 49ers=49ers;Pittsburgh Steelers=steelers;" +
  "Miami Dolphins=dolphins;Baltimore Ravens=ravens;Los Angeles Chargers=chargers;Cincinnati Bengals=bengals;" +
  "Seattle Seahawks=seahawks;Denver Broncos=broncos;Houston Texans=texans;Indianapolis Colts=colts;" +
  "Jacksonville Jaguars=jaguars;Atlanta Falcons=falcons;New Orleans Saints=saints;Cleveland Browns=browns;" +
  "Las Vegas Raiders=raiders;Chicago Bears=bears;Minnesota Vikings=vikings;Buffalo Bills=bills;" +
  "Green Bay Packers=packers;Dallas Cowboys=cowboys;New England Patriots=patriots;Kansas City Chiefs=chiefs;" +
  "Los Angeles Rams=rams";

const SPORT_PHRASE_SPEC =
  "motorsport:f1|formula 1|formula one|grand prix|motogp|moto gp|nascar|indycar|rally|wrc|supercars|formula e|eprix|e prix;" +
  "combat:one friday fights|one fighting championship|one championship|friday fights|ufc|mma|mixed martial arts|oktagon|zuffa|queensberry|boxing|boxer|wwe|raw|smackdown|nxt|aew|dynamite|rampage|collision|bellator|bkfc|pfl|glory|sumo|judo|karate|kickboxing|muay thai|taekwondo|combat|bout|bouts|fight night|gromda|mvpw|wrestling;" +
  "table_tennis:table tennis|ping pong|ittf|wtt;" +
  "tennis:atp|wta|wimbledon|australian open|french open|us open|roland garros|indian wells|stockholm open|tennis|davis cup|laver cup;" +
  "cricket:cricket|t20|t20i|t10|ipl|bbl|wbbl|big bash|wpl|psl|cpl|npl|bpl|sa20|ilt20|ilt t20|mlc|super smash|odi|one day international|test match|test series|test championship|icc|ashes|ranji|smat|abu dhabi t10|nepal premier league|youth odi|emerging nations trophy|world test championship|cricbuzz|crichd|cricify|smartcric|rcb|csk|kkr|srh|pbks|lsg|sydney sixers|melbourne stars|melbourne renegades|brisbane heat|perth scorchers|hobart hurricanes|adelaide strikers|sydney thunder|international league t20;" +
  "hockey:nhl|ice hockey|hockey|oilers|new york rangers|ny rangers|canucks|flyers|sharks|islanders|bruins|penguins|maple leafs|canadiens|blackhawks|red wings|avalanche|lightning|golden knights|dallas stars|carolina hurricanes|predators|st louis blues|minnesota wild|devils|capitals|sabres|senators|calgary flames|ducks|kraken|mammoth|coyotes|blue jackets|winnipeg jets|los angeles kings|florida panthers;" +
  "basketball:nba|wnba|nbl|euroleague|liga endesa|acb|basketball|fiba|ncaa basketball|cba|perth wildcats|tasmania jackjumpers|melbourne united|sydney kings|adelaide 36ers|brisbane bullets|illawarra hawks|cairns taipans|new zealand breakers|celtics|nets|hornets|bulls|cavaliers|mavericks|nuggets|pistons|warriors|rockets|pacers|clippers|lakers|grizzlies|heat|bucks|timberwolves|pelicans|knicks|thunder|magic|76ers|sixers|suns|trail blazers|blazers|sacramento kings|san antonio spurs|raptors|jazz|wizards;" +
  "american_football:nfl|redzone|red zone|super bowl|american football|patriots|chiefs|philadelphia eagles|cowboys|packers|49ers|pittsburgh steelers|dolphins|ravens|chargers|rams|bengals|seahawks|broncos|texans|colts|jaguars|commanders|arizona cardinals|falcons|saints|carolina panthers|tennessee titans|new york giants|new york jets|browns|raiders|bears|detroit lions|vikings|bills;" +
  "badminton:badminton|bwf|all england|thomas cup|uber cup;" +
  "kabaddi:kabaddi|pkl|pro kabaddi;" +
  "rugby:rugby|six nations|top 14|premiership rugby|super rugby|urc|all blacks|springboks|wallabies;" +
  "volleyball:volleyball|fivb|cev|beach volleyball|vnl;" +
  "golf:golf|pga|liv golf|ryder cup|masters|us open golf|british open|the open;" +
  "athletics:athletics|diamond league|world athletics|marathon;" +
  "darts:darts|pdc|world darts;" +
  "snooker:snooker|world snooker|cue sports;" +
  "cycling:cycling|tour de france|giro|vuelta|uci;" +
  "football:ucl|uefa|nations league|afcon|africa cup|concacaf|copa del rey|champions league|afc champions|europa league|conference league|premier league|epl|efl|championship|laliga|la liga|serie a|bundesliga|ligue 1|eredivisie|isl|indian super league|football|soccer|fifa|international friendly|club friendly|afc cup|fa cup|facup|saff|copa|femenino|golazo|fc|cf|chelsea|arsenal|liverpool|man utd|manchester|real madrid|barcelona|bayern|juventus|inter|milan|psg|atletico|dortmund|tottenham|napoli|roma|benfica|wolfsburg|betis|levante|albacete|leicester|blackpool|southampton|sheffield|wrexham|middlesbrough|swansea|portsmouth|burnley|sunderland|coventry|norwich|watford|millwall|derby|stoke|preston|cardiff|hibernian|aberdeen|celtic|psv|eindhoven|aek|como|feyenoord|porto|lens|leipzig|stuttgart|leverkusen|frankfurt|villarreal|sevilla|valencia|sociedad|bilbao|lyon|marseille|monaco|lille|ajax|galatasaray|fenerbahce|besiktas|olympiacos|copenhagen|salzburg|shakhtar|dynamo";

const CLUSTER_SPEC =
  "cricket::nepal-premier-league::channel~Nepal Premier League (NPL)~channel~nepal|npl~\\b(?:nepal\\s*premier\\s*league|npl)\\b;" +
  "cricket::abu-dhabi-t10::channel~Abu Dhabi T10 League~channel~dhabi|t10~\\babu\\s*dhabi\\s*(?:vs\\.?\\s*)?t10\\b;" +
  "cricket::wbbl::channel~Women's Big Bash League (WBBL)~channel~wbbl|bash~\\b(?:wbbl|women'?s\\s*big\\s*bash)\\b;" +
  "cricket::ilt20::show~International League T20~show~ilt20|ilt|t20~\\b(?:ilt\\s*t?20|international\\s*league\\s*t20)\\b;" +
  "combat::one-fighting-championship::show~ONE Fighting Championship~show~one|friday~\\b(?:one\\s*(?:fighting\\s*)?championship|one\\s*friday\\s*fights|friday\\s*fights)\\b;" +
  "combat::wwe-raw::show~WWE Monday Night Raw~show~raw~\\b(?:wwe\\s*[:|-]?\\s*raw|monday\\s*night\\s*raw)\\b;" +
  "combat::wwe-smackdown::show~WWE Friday Night SmackDown~show~smackdown~\\b(?:wwe\\s*[:|-]?\\s*smackdown|friday\\s*night\\s*smackdown|smackdown)\\b;" +
  "combat::wwe-nxt::show~WWE NXT~show~nxt~\\b(?:wwe\\s*[:|-]?\\s*nxt|nxt)\\b;" +
  "motorsport::formula-1::session~Formula 1~session~f1|formula~\\b(?:f1|formula\\s*1|formula\\s*one)\\b~1;" +
  "motorsport::motogp::session~MotoGP~session~motogp|moto~\\b(?:motogp|moto\\s*gp)\\b~1;" +
  "american_football::nfl-redzone::channel~NFL RedZone~channel~redzone|zone~\\b(?:nfl\\s*(?:\\||vs\\.?)?\\s*red\\s*zone|red\\s*zone|redzone)\\b;" +
  "tennis::stockholm-open::channel~Stockholm Open~channel~stockholm|atp~\\b(?:stockholm\\s*open|atp\\s*250\\s*(?:&|vs\\.?)\\s*(?:wta\\s*hong\\s*kong|stockholm\\s*open))\\b;" +
  "combat::aew-dynamite::show~AEW Dynamite~show~dynamite~\\baew\\s*[:|-]?\\s*dynamite\\b;" +
  "combat::aew-collision::show~AEW Collision~show~collision~\\baew\\s*[:|-]?\\s*collision\\b;" +
  "football::indian-super-league::channel~Indian Super League (ISL)~channel~isl|indian~\\b(?:indian\\s*super\\s*league|isl)\\b;" +
  "golf::golf-eventos::channel~Golf Eventos~channel~eventos|evento~\\bgolf\\s*eventos?\\b;" +
  "tennis::tennis-evento::channel~Tennis Evento~channel~eventos|evento~\\btennis\\s*eventos?\\b";

let cachedTables: TaxonomyTables | null = null;

export function getTaxonomy(): TaxonomyTables {
  if (cachedTables) return cachedTables;
  const contextualTeams: Record<string, Record<string, string>> = Object.create(null);
  contextualTeams.hockey = kvDict("kings=Los Angeles Kings;stars=Dallas Stars;panthers=Florida Panthers;jets=Winnipeg Jets;rangers=New York Rangers;hurricanes=Carolina Hurricanes");
  contextualTeams.american_football = kvDict("giants=New York Giants;jets=New York Jets;panthers=Carolina Panthers;cardinals=Arizona Cardinals;titans=Tennessee Titans;lions=Detroit Lions;eagles=Philadelphia Eagles");
  contextualTeams.basketball = kvDict("kings=Sacramento Kings;spurs=San Antonio Spurs");
  contextualTeams.cricket = kvDict("kings=Punjab Kings;lions=England Lions");

  const sportUni = new Map<string, SportMatchEntry>(), sportBi = new Map<string, SportMatchEntry>(), sportTri = new Map<string, SportMatchEntry>();
  const sportBiFirst = new Set<string>(), sportTriFirst = new Set<string>();
  const rows = SPORT_PHRASE_SPEC.split(";");
  for (let rank = 0; rank < rows.length; rank++) {
    const row = rows[rank];
    if (!row) continue;
    const ci = row.indexOf(":"), sport = row.slice(0, ci), csv = row.slice(ci + 1);
    for (const phrase of csv.split("|")) {
      const parts = phrase.split(" "), first = parts[0];
      if (!first) continue;
      if (parts.length === 1) { if (!sportUni.has(phrase)) sportUni.set(phrase, { sport, rank }); }
      else if (parts.length === 2) { sportBiFirst.add(first); if (!sportBi.has(phrase)) sportBi.set(phrase, { sport, rank }); }
      else { sportTriFirst.add(first); if (!sportTri.has(phrase)) sportTri.set(phrase, { sport, rank }); }
    }
  }

  const clusters: TournamentCluster[] = [], clusterTriggers = new Map<string, number[]>();
  for (const row of CLUSTER_SPEC.split(";")) {
    const [canonicalKey = "", displayName = "", kind = "show", tr = "", pat = "", split = ""] = row.split("~");
    const idx = clusters.length;
    clusters.push({ canonicalKey, displayName, sportCategory: canonicalKey.slice(0, canonicalKey.indexOf("::")), kind: kind as TournamentCluster["kind"], splitBySession: split === "1", regex: new RegExp(pat, "i") });
    for (const t of tr.split("|")) { const a = clusterTriggers.get(t); if (a) a.push(idx); else clusterTriggers.set(t, [idx]); }
  }

  cachedTables = {
    teamAliases: parseAliases(TEAM_ALIAS_SPEC),
    contextualTeams,
    sportUni, sportBi, sportTri, sportBiFirst, sportTriFirst,
    clusters, clusterTriggers,
    cricketNations: new Set("india|pakistan|australia|england|south africa|new zealand|west indies|sri lanka|bangladesh|afghanistan|zimbabwe|ireland|scotland|netherlands|nepal|oman|namibia|uae|united arab emirates|thailand|papua new guinea|uganda|kenya|hong kong|malaysia|ind|pak|aus|eng|nz|sl|sa|ban|afg|zim|wi|ned|tha|ire|sco|png|nep".split("|")),
    sportFilterAliases: parseAliases(
      "football=soccer|epl|ucl|laliga|isl;combat=combat_sports|combatsports|mma|ufc|boxing|wwe|aew|wrestling;motorsport=f1|formula1|motogp;" +
      "basketball=nba|nbl|wnba|euroleague;hockey=nhl|ice_hockey|icehockey;american_football=nfl|americanfootball|american-football;" +
      "table_tennis=pingpong|tabletennis|table-tennis;cricket=ipl|t20|odi|bbl|wbbl|psl|npl;tennis=atp|wta;golf=pga",
      false
    ),
  };
  return cachedTables;
}

export function getExpectedDurationMinutes(sport: string, format?: string | null): number {
  if (sport === "cricket") return format === "t10" ? 150 : format === "the_hundred" ? 210 : format === "t20" ? 270 : format === "odi" ? 540 : format === "test" ? 7200 : 300;
  if (sport === "motorsport") return format === "race" || !format ? 210 : 120;
  return sport === "football" || sport === "rugby" ? 150 : sport === "basketball" || sport === "hockey" ? 180 : sport === "american_football" ? 240 : sport === "tennis" || sport === "combat" ? 270 : sport === "golf" ? 540 : sport === "cycling" ? 360 : 210;
}
