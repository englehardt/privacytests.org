// # test.js: Runs privacy tests on browsers
//
// Define a set of browsers to test in a YAML file.
// Usage: `node index config/production.yaml`

// ## imports

const fs = require('fs');
const { execSync } = require('child_process');
const minimist = require('minimist');
const dateFormat = require('dateformat');
const YAML = require('yaml');
const os = require('os');
const process = require('process');
const fetch = require('node-fetch');
const render = require('./render');
const { Browser } = require("./browser.js");

const DEFAULT_TIMEOUT_MS = 60000;

// ## Utility functions

// Returns a deep copy of a JSON object.
const deepCopy = (x) => JSON.parse(JSON.stringify(x));

// Read config file in YAML or JSON.
const parseConfigFile = (configFile, repeat = 1) => {
  let configFileContents = fs.readFileSync(configFile, 'utf8');
  let rawConfigs = YAML.parse(configFileContents);
  return expandConfigList(rawConfigs, repeat);
};

// Takes a list of browser configs, and repeats or removes them as needed.
const expandConfigList = (configList, repeat = 1) => {
  let results = [];
  for (let config of configList) {
    if (!config.disable) {
      config2 = deepCopy(config);
      delete config2["repeat"];
      results = [].concat(results, Array((config.repeat ?? 1) * (repeat ?? 1)).fill(config2));
    }
  }
  return results;
};

// Returns a promise that sleeps for the given millseconds.
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Reads the current git commit hash for this program in a string. Used
// when reporting results, to make them easier to reproduce.
const gitHash = () => execSync('git rev-parse HEAD', { cwd: __dirname}).toString().trim();

// Fetch results from a json API.
const fetchJSON = async (...fetchArgs) => {
  let response = await fetch(...fetchArgs);
  return response.json();
};

// Fetch server reflexive IP address
const fetch_ipAddress = async () => {
  const wtfismyip = await fetchJSON("https://wtfismyip.com/json");
  return wtfismyip["YourFuckingIPAddress"];
};

// ## Prepare system

// Install Monoton as a system font so that we can see if
// it is leaked by browsers.
const installTestFont = () => {
  const homedir = os.homedir();
  const userFontDir = {
    "darwin": `${homedir}/Library/Fonts`,
    "linux": `${homedir}/.local/share/fonts`
  }[process.platform];
  if (!fs.existsSync(userFontDir)) {
    fs.mkdirSync(userFontDir, {recursive: true});
  }
  const fontDestination = `${userFontDir}/Monoton-Regular.ttf`;
  if (!fs.existsSync(fontDestination)) {
    fs.copyFileSync(`${__dirname}/Monoton-Regular.ttf`, fontDestination);
  }
};

// ## Testing

// Borrowed from https://github.com/brave/brave-core/blob/50df76971db6a6023b3db9aead0827606162dc9c/browser/net/brave_site_hacks_network_delegate_helper.cc#L29
// and https://github.com/jparise/chrome-utm-stripper:
const TRACKING_QUERY_PARAMETERS =
  {
    // https://github.com/brave/brave-browser/issues/4239
    "fbclid": "Facebook Click Identifier",
    "gclid": "Google Click Identifier",
    "msclkid": "Microsoft Click ID",
    "mc_eid": "Mailchimp Email ID (email recipient's address)",
    // https://github.com/brave/brave-browser/issues/9879
    "dclid": "DoubleClick Click ID (Google)",
    // https://github.com/brave/brave-browser/issues/13644
    "oly_anon_id": "Omeda marketing 'anonymous' customer id",
    "oly_enc_id": "Omeda marketing 'known' customer id",
    // https://github.com/brave/brave-browser/issues/11579
    "_openstat": "Yandex tracking parameter",
    // https://github.com/brave/brave-browser/issues/11817
    "vero_conv": "Vero tracking parameter",
    "vero_id": "Vero tracking parameter",
    // https://github.com/brave/brave-browser/issues/13647
    "wickedid": "Wicked Reports e-commerce tracking",
    // https://github.com/brave/brave-browser/issues/11578
    "yclid": "Yandex Click ID",
    // https://github.com/brave/brave-browser/issues/8975
    "__s": "Drip.com email address tracking parameter",
    // https://github.com/brave/brave-browser/issues/17451
    "rb_clickid": "Unknown high-entropy tracking parameter",
    // https://github.com/brave/brave-browser/issues/17452
    "s_cid": "Adobe Site Catalyst tracking parameter",
    // https://github.com/brave/brave-browser/issues/17507
    "ml_subscriber": "MailerLite email tracking",
    "ml_subscriber_hash": "MailerLite email tracking",
    // https://github.com/brave/brave-browser/issues/9019
    "_hsenc": "HubSpot tracking parameter",
    "__hssc": "HubSpot tracking parameter",
    "__hstc": "HubSpot tracking parameter",
    "__hsfp": "HubSpot tracking parameter",
    "hsCtaTracking": "HubSpot tracking parameter",
    // https://github.com/jparise/chrome-utm-stripper
    "mkt_tok": "Adobe Marketo tracking parameter",
    "igshid": "Instagram tracking parameter",
  };

const queryParameterTestUrl = (parameters) => {
  let secret = Math.random().toString().slice(2);
  let baseURL = "https://arthuredelstein.net/test-pages/query.html";
  let queryString = `?controlParam=controlValue`;
  for (let param of Object.keys(parameters)) {
    queryString += `&${param}=${secret}`;
  }
  return baseURL + queryString;
};

const getJointResult = (writeResults, readResultsSameFirstParty, readResultsDifferentFirstParty) => {
  let jointResult = {};
  for (let test in readResultsDifferentFirstParty) {
    let { write, read, description, result: readDifferentFirstParty } = readResultsDifferentFirstParty[test];
    let { result: readSameFirstParty } = readResultsSameFirstParty[test];
    let { result: writeResult } = writeResults[test];
    let unsupported = (writeResult === "Error: Unsupported");
    let readSameFirstPartyFailedToFetch = readSameFirstParty ? readSameFirstParty.startsWith("Error: Failed to fetch") : false;
    let readDifferentFirstPartyFailedToFetch = readDifferentFirstParty ? readDifferentFirstParty.startsWith("Error: Failed to fetch") : false;
    unsupported = unsupported || (readSameFirstParty ? readSameFirstParty.startsWith("Error: No requests received") : false);
    unsupported = unsupported || (readSameFirstParty ? readSameFirstParty.startsWith("Error: image load failed") : false);
    let testFailed = !unsupported && (!readSameFirstParty || (readSameFirstParty.startsWith("Error:") && !readSameFirstPartyFailedToFetch));
    let passed = (testFailed || unsupported)
      ? undefined
      : (readSameFirstParty !== readDifferentFirstParty) ||
      (readSameFirstPartyFailedToFetch && readDifferentFirstPartyFailedToFetch);
    jointResult[test] = { write, read, unsupported, readSameFirstParty, readDifferentFirstParty, passed, testFailed, description };
  }
  return jointResult;
}

const annotateQueryParameters = (queryParametersRaw) => {
  let query = {};
  for (let param of Object.keys(TRACKING_QUERY_PARAMETERS)) {
    query[param] = {
      value: queryParametersRaw[param],
      passed: (queryParametersRaw[param] === undefined),
      description: TRACKING_QUERY_PARAMETERS[param],
    };
  }
  return query;
};

// Run all of our privacy tests using selenium for a given driver. Returns
// a map of test types to test result maps. Such as
// `
// { "fingerprinting" : { "window.screen.width" : { /* results */ }, ... },
//   "misc" : { ... },
//   "https" : { ... },
//   "navigation" : { ... },
//   "supercookies" : { ... } }
const runTests = async (browser) => {
  try {
    const secret = Math.random().toString().slice(2);
    const iframe_root_same = "https://arthuredelstein.net/test-pages";
    const iframe_root_different = "https://test-pages.privacytests.org";
    // Supercookies
    const writeResults = await browser.runTest(`${iframe_root_same}/supercookies.html?mode=write&default=${secret}`);
    let readParams = "";
    for (let [test, data] of Object.entries(writeResults)) {
      if ((typeof data["result"]) === "string") {
        readParams += `&${test}=${encodeURIComponent(data["result"])}`;
      }
    }
    const readResultsSameFirstParty = await browser.runTest(`${iframe_root_same}/supercookies.html?mode=read${readParams}`);
    const readResultsDifferentFirstParty = await browser.runTest(`${iframe_root_different}/supercookies.html?mode=read${readParams}`);
    const supercookies = getJointResult(writeResults, readResultsSameFirstParty, readResultsDifferentFirstParty);
    // Navigation
    const [writeResults2, readResultsSameFirstParty2, readResultsDifferentFirstParty2] =
      await browser.runTest(`${iframe_root_same}/navigation.html?mode=write&default=${secret}`, 3);
    const navigation = getJointResult(writeResults2, readResultsSameFirstParty2, readResultsDifferentFirstParty2);
    // Move ServiceWorker from navigation to supercookies:
    supercookies["ServiceWorker"] = navigation["ServiceWorker"];
    delete navigation["ServiceWorker"];
    // Fingerprinting
    const fingerprinting = await browser.runTest(`${iframe_root_same}/fingerprinting.html`);
    // Misc
    const ipAddress = await fetch_ipAddress();
    console.log({ipAddress});
    const misc = await browser.runTest(`${iframe_root_same}/misc.html?ipAddress=${ipAddress}`);
    // Query
    const queryParametersRaw = await browser.runTest(queryParameterTestUrl(TRACKING_QUERY_PARAMETERS));
    const query = annotateQueryParameters(queryParametersRaw);
    // HTTPS
    const https1 = await browser.runTest(`${iframe_root_same}/https.html`);
    const [https2, https3] = await browser.runTest(
      `http://upgradable.arthuredelstein.net/upgradable.html?source=address`, 2);
    const https4Promise = browser.runTest(`http://insecure.arthuredelstein.net/insecure.html`);
    const result = await Promise.race([sleep(10000), https4Promise]);
    const https4 = result === undefined ?
      { "Insecure website": { passed: true, result: "Insecure website never loaded" } }:
      await https4Promise;
    const https = Object.assign({}, https1, https2, https3, https4); // Merge results
    return { supercookies, fingerprinting, misc, query, https, navigation };
  } catch (e) {
    console.log(e);
    return null;
  }
};

// Runs a batch of tests (multiple browsers).
// Returns results in a JSON object.
const runTestsBatch = async (configList, {shouldQuit} = {shouldQuit:true}) => {
  let all_tests = [];
  let timeStarted = new Date().toISOString();
  let git = await gitHash();
  for (let config of configList) {
    try {
      let { browser, prefs, incognito, tor } = config;
      console.log("\nnext test:", config);
      let browserObject = new Browser(config);
      await browserObject.launch();
      let timeStarted = new Date().toISOString();
      let reportedVersion = browserObject.version;
      console.log(`${browser} version found: ${reportedVersion}`);
      let testResults = await runTests(browserObject);
      //      console.log({shouldQuit});
      //console.log(testResults);
      all_tests.push({ browser, reportedVersion,
                       testResults, timeStarted,
                       capabilities: {os: os.type(), os_version: os.version() },
                       incognito, tor });
      if (shouldQuit) {
        await browserObject.kill();
      }
    } catch (e) {
      console.log(e);
    }
  }
  let timeStopped = new Date().toISOString();
  return { all_tests, git, timeStarted, timeStopped };
};

// ## Writing results

// Takes our results in a JSON object and writes them to disk.
// The file name looks like `yyyymmdd__HHMMss.json`.
const writeDataSync = (data) => {
  let dateStub = dateFormat(new Date(), "yyyymmdd_HHMMss", true);
  let filePath = `out/results/${dateStub}.json`;
  fs.mkdirSync("out/results", { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data));
  console.log(`Wrote results to "${filePath}".`);
  return filePath;
};

// The main program
const main = async () => {
  // Read config file and flags from command line
//  logging.installConsoleHandler();
//  logging.getLogger().setLevel(logging.Level.ALL);
//  logging.getLogger("browser").setLevel(logging.Level.ALL);
  installTestFont();
  let { _ : [configFile], debug, only, list, repeat, aggregate } =
    minimist(process.argv.slice(2), opts = { default: { aggregate: true }});
  if (list) {
    let capabilityList = await fetchBrowserstackCapabilities();
    for (let capability of capabilityList) {
      console.log(capability);
    }
  } else {
    let configList = parseConfigFile(configFile, repeat);
    let filteredConfigList = configList.filter(
      d => only ? d.browser.startsWith(only) : true);
    console.log("List of browsers to run:", filteredConfigList);
    let dataFile = writeDataSync(await runTestsBatch(filteredConfigList,
                                                     { shouldQuit: !debug }));
    render.render({ dataFile, aggregate });
  }
};

main();


