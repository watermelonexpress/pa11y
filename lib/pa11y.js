'use strict';

const runAction = require('./action');
const extend = require('node.extend');
const inspect = require('util').inspect;
const path = require('path');
const pkg = require('../package.json');
const promiseTimeout = require('p-timeout');
const puppeteer = require('puppeteer');

module.exports = pa11y;

 /* Run accessibility tests on a web page.
 * @public
 * @param {String} [url] - The URL to run tests against.
 * @param {Object} [options={}] - Options to change the way tests run.
 * @param {Function} [callback] - An optional callback to use instead of promises.
 * @returns {Promise} Returns a promise which resolves with a results object.
 */
async function pa11y(url, options = {}, callback) {
	const state = {};

	/* eslint-disable prefer-rest-params */
	// Check for presence of a callback function
	if (typeof arguments[arguments.length - 1] === 'function') {
		callback = arguments[arguments.length - 1];
	} else {
		callback = undefined;
	}
	/* eslint-enable prefer-rest-params */

	try {

		// Switch parameters if only an options object is provided,
		// and default the options
		if (typeof url !== 'string') {
			options = url;
			url = options.url;
		}
		url = sanitizeUrl(url);
		options = defaultOptions(options);

		// Verify that the given options are valid
		verifyOptions(options);

		// Call the actual Pa11y test runner with
		// a timeout if it takes too long
		const results = await promiseTimeout(
			runPa11yTest(url, options, state),
			options.timeout,
			`Pa11y timed out (${options.timeout}ms)`
		);

		// Run callback if present, and resolve with results
		if (callback) {
			return callback(null, results);
		}
		return results;

	} catch (error) {
		if (state.browser) {
			state.browser.close();
		}

		// Run callback if present, and reject with error
		if (callback) {
			return callback(error);
		}
		throw error;
	}
}

/**
 * Internal Pa11y test runner.
 * @private
 * @param {String} [url] - The URL to run tests against.
 * @param {Object} [options] - Options to change the way tests run.
 * @param {Object} [state] - An object state information will be added to.
 * @returns {Promise} Returns a promise which resolves with a results object.
 */
async function runPa11yTest(url, options, state) {

	options.log.info(`Running Pa11y on URL ${url}`);

	// Launch a Headless Chrome browser and create a page
	// We use a state object which is accessible from the
	// wrapping function
	options.log.debug('Launching Headless Chrome');
	const browser = state.browser = await puppeteer.launch(options.chromeLaunchConfig);
	const page = await browser.newPage();

	// Intercept page requests, we need to do this in order
	// to set the HTTP method or post data
	await page.setRequestInterception(true);

	// Intercept requests so we can set the HTTP method
	// and post data. We only want to make changes to the
	// first request that's handled, which is the request
	// for the page we're testing
	let interceptionHandled = false;
	page.on('request', interceptedRequest => {
		const overrides = {};
		if (!interceptionHandled) {

			// Override the request method
			options.log.debug('Setting request method');
			overrides.method = options.method;

			// Override the request headers (and include the user-agent)
			options.log.debug('Setting request headers');
			overrides.headers = {
				'user-agent': options.userAgent
			};
			for (const [key, value] of Object.entries(options.headers)) {
				overrides.headers[key.toLowerCase()] = value;
			}

			// Override the request POST data if present
			if (options.postData) {
				options.log.debug('Setting request POST data');
				overrides.postData = options.postData;
			}

			interceptionHandled = true;
		}
		interceptedRequest.continue(overrides);
	});

	// Listen for console logs on the page so that we can
	// output them for debugging purposes
	page.on('console', (...args) => {
		const message = args.map(inspect).join(' ');
    options.log.debug(`Browser Console: ${message}`);
  });

  options.log.debug(`Setting authentication cookie\n`);
  await page.setCookie(options.authCookie);

	// Navigate to the URL we're going to test
	options.log.debug('Opening URL in Headless Chrome');

	const gotoConfig = { waitUntil: 'networkidle0' };
	gotoConfig.timeout = options.timeout;

  await page.goto(url, gotoConfig);

  const bodyHandle = await page.$('body');
  const html = await page.evaluate(body => body.innerHTML, bodyHandle);
  await bodyHandle.dispose();

	// Resize the viewport
	await page.setViewport(options.viewport);

	// Run actions
	if (options.actions.length) {
		options.log.info('Running actions');
		for (const action of options.actions) {
			await runAction(browser, page, options, action);
		}
		options.log.info('Finished running actions');
	}

	// Inject HTML CodeSniffer and the Pa11y test runner
	options.log.debug('Injecting HTML CodeSniffer');
	await page.addScriptTag({ path: `${__dirname}/vendor/HTMLCS.js` });
	options.log.debug('Injecting Pa11y');
	await page.addScriptTag({ path: `${__dirname}/runner.js` });

	// Launch the test runner!
	options.log.debug('Running Pa11y on the page');
	/* istanbul ignore next */
	if (options.wait > 0) {
		options.log.debug(`Waiting for ${options.wait}ms`);
	}
	/* eslint-disable no-shadow */
	const results = await page.evaluate(options => {
		/* global _runPa11y */
		return _runPa11y(options);
	}, {
		hideElements: options.hideElements,
		ignore: options.ignore,
		rootElement: options.rootElement,
		rules: options.rules,
		standard: options.standard,
		wait: options.wait
	});
	/* eslint-enable no-shadow */

	options.log.debug(`Document title: "${results.documentTitle}"`);

	// Generate a screen capture
	if (options.screenCapture) {
		options.log.info(`Capturing screen, saving to "${options.screenCapture}"`);
		try {
			await page.screenshot({
				path: options.screenCapture,
				fullPage: true
			});
		} catch (error) {
			options.log.error(`Error capturing screen: ${error.message}`);
		}
	}

	// Close the browser and return the Pa11y results
	browser.close();
	return results;
}

/**
 * Default the passed in options using Pa11y's defaults.
 * @private
 * @param {Object} [options={}] - The options to apply defaults to.
 * @returns {Object} Returns the defaulted options.
 */
function defaultOptions(options) {
	options = extend({}, pa11y.defaults, options);
	options.ignore = options.ignore.map(ignored => ignored.toLowerCase());
	if (!options.includeNotices) {
		options.ignore.push('notice');
	}
	if (!options.includeWarnings) {
		options.ignore.push('warning');
	}
	return options;
}

/**
 * Verify that passed in options are valid.
 * @private
 * @param {Object} [options={}] - The options to verify.
 * @returns {Undefined} Returns nothing.
 * @throws {Error} Throws if options are not valid.
 */
function verifyOptions(options) {
	if (!pa11y.allowedStandards.includes(options.standard)) {
		throw new Error(`Standard must be one of ${pa11y.allowedStandards.join(', ')}`);
	}
}

/**
 * Sanitize a URL, ensuring it has a scheme. If the URL begins with a slash or a period,
 * it will be resolved as a path against the current working directory. If the URL does
 * begin with a scheme, it will be prepended with "http://".
 * @private
 * @param {String} url - The URL to sanitize.
 * @returns {String} Returns the sanitized URL.
 */
function sanitizeUrl(url) {
	if (/^\//i.test(url)) {
		return `file://${url}`;
	}
	if (/^\./i.test(url)) {
		return `file://${path.resolve(process.cwd(), url)}`;
	}
	if (!/^(https?|file):\/\//i.test(url)) {
		return `http://${url}`;
	}
	return url;
}

/* istanbul ignore next */
/* eslint-disable no-empty-function */
const noop = () => {};
/* eslint-enable no-empty-function */

/**
 * Default options (excluding 'level', 'reporter', and 'threshold' which are only
 * relevant when calling bin/pa11y from the CLI)
 * @public
 */
pa11y.defaults = {
	actions: [],
	chromeLaunchConfig: {
		ignoreHTTPSErrors: true
	},
	headers: {},
	hideElements: null,
	ignore: [],
	includeNotices: false,
	includeWarnings: false,
	log: {
		debug: noop,
		error: noop,
		info: noop
	},
	method: 'GET',
	postData: null,
	rootElement: null,
	rules: [],
	screenCapture: null,
	standard: 'WCAG2AA', // DONE
	timeout: 30000,
	userAgent: `pa11y/${pkg.version}`,
	viewport: {
		width: 1280,
		height: 1024
	},
	wait: 0
};

/**
 * Allowed a11y standards.
 * @public
 */
pa11y.allowedStandards = [
	'Section508',
	'WCAG2A',
	'WCAG2AA',
	'WCAG2AAA'
];

/**
 * Alias the `isValidAction` method
 */
pa11y.isValidAction = runAction.isValidAction;
