// @ts-check
const chalk = require('chalk');
const cliSelect = require('cli-select');
const fetch = require('node-fetch').default;
const fs = require('fs');
const JSZip = require('jszip');
const path = require('path');
const puppeteer = require('puppeteer');
const readline = require('readline');
const uuid = require('uuid');
const package = require('./package.json');

/**
 * @typedef Directory
 * @property {string} id
 * @property {string} path
 */

/**
 * @typedef Config
 * @property {string} [deviceToken]
 * @property {Directory} [parent]
 */

const configFile = path.join(__dirname, 'config.json');
// "Discover webapp" for auth host?
const AUTH_API = 'https://webapp-production-dot-remarkable-production.appspot.com';

/** @type {() => Config} */
const readConfig = () => {
    try {
        const config = fs.readFileSync(configFile, 'utf-8');
        return JSON.parse(config);
    } catch {
        return {};
    }
};

/** @type {(config: Config) => void} */
const saveConfig = (config) => {
    fs.writeFileSync(configFile, JSON.stringify(config));
};

/** @type {(method: string, url: string, options?: object) => ReturnType<fetch>} */
const request = async (method, url, options) => {
    const response = await fetch(url, {
        method,
        ...options,
        headers: {
            'User-Agent': `digli/ctc-puzzle-import v${package.version}`,
            ...options?.headers,
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Got a ${response.status} response at ${url}: ${body}`);
    }

    return response;
};

/** @type {(url: string) => Promise<[string, Buffer]>} */
const fetchPuzzleAsPDF = async (url) => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setCookie({
        name: 'CookieConsent',
        value: '{stamp:%270kLHuwNDMwNQd43gONztu/5XvN2fgihE7hST78UmO+hotXNDfgLurQ==%27%2Cnecessary:true%2Cpreferences:true%2Cstatistics:true%2Cmarketing:true%2Cver:1%2Cutc:1619256930043%2Cregion:%27se%27}',
        url,
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Not sure how to correctly listen to an event on a global variable.
    // This does not work: ReferenceError: Framework is not defined
    // await page.evaluate(() => {
    //     return new Promise(resolve => {
    //         // @ts-ignore
    //         Framework.app.puzzle.on('start', resolve);
    //     });
    // });

    await page.waitForFunction(() => !!document.querySelector('.puzzle-author').textContent);

    const puzzleTitleElement = await page.waitForSelector('.puzzle-title');
    const puzzleTitle = await puzzleTitleElement.evaluate(el => el.textContent);
    console.log('Found puzzle title:', chalk.green.bold(puzzleTitle))

    const pdf = await page.pdf({ format: 'a4' });

    await browser.close();

    return [puzzleTitle, pdf];
};

// Docs: https://github.com/splitbrain/ReMarkableAPI/wiki/Authentication
/** @type {(oneTimeCode: string) => Promise<string>} */
const getDeviceToken = async (oneTimeCode) => {
    const payload = {
        code: oneTimeCode,
        deviceDesc: 'desktop-windows', // Does this matter?
        deviceID: uuid.v4(),
    };

    const url = `${AUTH_API}/token/json/2/device/new`; // PR to update this in wiki
    const response = await request('POST', url, {
        body: JSON.stringify(payload),
    });

    return response.text();
};

/** @type {(token: string) => Promise<string>} */
const getAuthToken = async (deviceToken) => {
    const url = `${AUTH_API}/token/json/2/user/new`;
    const response = await request('POST', url, {
        headers: { 'Authorization': `Bearer ${deviceToken}` },
    });

    return response.text();
};

// Docs: https://github.com/splitbrain/ReMarkableAPI/wiki/Service-Discovery
/** @type {() => Promise<string>} */
const discoverStorageAPIHost = async () => {
    const url = 'https://service-manager-production-dot-remarkable-production.appspot.com/service/json/1/document-storage?environment=production&group=auth0%7C5a68dc51cb30df3877a1d7c4&apiVer=2';
    const response = await request('GET', url);
    const body = await response.json();
    return body.Host;
};

// Inspired by https://github.com/Ogdentrod/reMarkable-typescript/blob/master/src/remarkable.ts
/** @type {(id: string, pdfContent: Buffer) => Promise<Buffer>} */
const zipMyPDF = async (id, pdfContent) => {
    const zip = new JSZip();

    zip.file(`${id}.content`, JSON.stringify({
      extraMetadata: {},
      fileType: 'pdf',
      lastOpenedPage: 0,
      lineHeight: -1,
      margins: 180,
      pageCount: 0,
      textScale: 1,
      transform: {},
    }));
    zip.file(`${id}.pagedata`, []);
    zip.file(`${id}.pdf`, pdfContent);

    return zip.generateAsync({ type: 'nodebuffer' });
};

// https://github.com/splitbrain/ReMarkableAPI/wiki/Storage#response-example
/** @type {(token: string, storageHost: string) => Promise<Array>} */
const listAllFiles = async (token, storageHost) => {
    const url = `https://${storageHost}/document-storage/json/2/docs`;
    const response = await request('GET', url, {
        headers: { 'Authorization': `Bearer ${token}` },
    });

    return response.json();
};

/** @type {(files: Array) => Array<Directory>} */
const getDirectoryHierarchy = files => {
    const directories = files.filter(file => file.Type === 'CollectionType');
    const dirsById = new Map(directories.map(dir => [dir.ID, dir]));

    const getPath = dir => {
        let path;
        if (dir.Parent) {
            const parent = dirsById.get(dir.Parent);
            path = getPath(parent);
        } else {
            path = '/';
        }
        path += dir.VissibleName + '/';
        return path;
    };

    return directories.map(dir => ({ id: dir.ID, path: getPath(dir) }));
};

/** @type {(token: string, storageHost: string, id: string) => Promise<string>} */
const createMetadataPlaceholder = async (token, storageHost, id) => {
    const payload = [{
        ID: id,
        Type: 'DocumentType',
        Version: 1,
    }];

    const url = `https://${storageHost}/document-storage/json/2/upload/request`;
    const response = await request('PUT', url, {
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(payload),
    });

    const body = await response.json();
    const item = body[0];
    if (!item.Success) {
        throw new Error(`Request unsuccessful: ${item.Message}`);
    }

    return item.BlobURLPut;
};

/** @type {(token: string, storageHost: string, metadata: object) => Promise} */
const updateDocMetadata = async (token, storageHost, metadata) => {
    const url = `https://${storageHost}/document-storage/json/2/upload/update-status`;
    const response = await request('PUT', url, {
        headers: { 'Authorization': `Bearer ${token}` },
        body: JSON.stringify([metadata]),
    });

    const body = await response.json();
    const item = body[0];
    if (!item.Success) {
        throw new Error(`Request unsuccessful: ${item.Message}`);
    }
};

// Docs: https://github.com/splitbrain/ReMarkableAPI/wiki/Storage
/** @type {(token: string, storageHost: string, pdfContent: Buffer, fileName: string, parent?: string) => Promise} */
const uploadPDF = async (token, storageHost, pdfContent, fileName, parent) => {
    const id = uuid.v4();

    console.log('Creating metadata placeholder...');
    const blobURL = await createMetadataPlaceholder(token, storageHost, id);

    console.log('Uploading file...');
    const zipContent = await zipMyPDF(id, pdfContent);
    await request('PUT', blobURL, {
        body: zipContent,
    });

    console.log('Updating document metadata...');
    const docMetadata = {
        ID: id,
        VissibleName: fileName, // Typo is intended
        deleted: false,
        lastModified: new Date().toISOString(),
        ModifiedClient: new Date().toISOString(),
        metadatamodified: false,
        modified: false,
        parent: parent || '',
        pinned: false,
        synced: true,
        type: 'DocumentType',
        version: 1,
    };

    await updateDocMetadata(token, storageHost, docMetadata);
};

/** @type {(puzzleUrl: string) => Promise} */
const main = async (puzzleUrl) => {
    const config = readConfig();

    const rl = readline.createInterface(process.stdin, process.stdout);

    /** @type {(question: string) => Promise<string>} */
    const prompt = async question => new Promise(resolve => {
        rl.question(question, resolve);
    });

    if (config.deviceToken) {
        console.log('Device token exists');
    } else {
        console.log('No device token found');
        console.log('Visit https://my.remarkable.com/device/connect/desktop to generate a one-time code.');
        let oneTimeCode = await prompt('Enter one-time code: ');
        oneTimeCode = oneTimeCode.trim();
    
        while (oneTimeCode.length !== 8) {
            oneTimeCode = await prompt('Invalid code, try again: ');
            oneTimeCode = oneTimeCode.trim();
        }
    
        config.deviceToken = await getDeviceToken(oneTimeCode);
        saveConfig(config);
        console.log('Device token stored');
    }

    console.log('Fetching auth token...');
    const token = await getAuthToken(config.deviceToken);
    
    console.log('Discovering storage API host name...');
    const storageHost = await discoverStorageAPIHost();

    let selectParentDirectory = true;
    if (config.parent) {
        console.log(`Current parent directory is set to ${chalk.green.bold(config.parent.path)}.`);
        const answer = await prompt('Do you wish to switch parent directory? (y/n): ');
        selectParentDirectory = answer.trim().toLowerCase() == 'y';
    }

    if (selectParentDirectory) {
        const files = await listAllFiles(token, storageHost);
        const directoryHierarchy = getDirectoryHierarchy(files);
        // Add root directory
        directoryHierarchy.push({ id: undefined, path: '/' })
        directoryHierarchy.sort((a, b) => a.path.localeCompare(b.path));
    
        console.log('Select parent directory:');
        const selectedEntry = await cliSelect({
            values: directoryHierarchy,
            valueRenderer: ({ path }, selected) => selected ? chalk.green.bold(path) : path,
        });

        config.parent = selectedEntry.value;
        saveConfig(config);
        console.log('Selected parent directory:', chalk.green.bold(config.parent.path));
    }

    console.log('Fetching puzzle...');
    const [puzzleTitle, pdfContent] = await fetchPuzzleAsPDF(puzzleUrl);

    console.log('Uploading...');
    await uploadPDF(token, storageHost, pdfContent, puzzleTitle, config.parent.id);
    console.log('✅ Puzzle synced with reMarkable:', chalk.green.bold(config.parent.path + puzzleTitle));

    rl.close();
};

const [puzzleUrl] = process.argv.slice(2);

if (!puzzleUrl) {
    console.log(`Usage: ${process.argv[0]} ${process.argv[1]} <puzzle-url>`);
    process.exit(1);
}

main(puzzleUrl)
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
