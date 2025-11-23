let locationCache = new Map();
const CACHE_KEY = 'twitter_location_cache';
const CACHE_EXPIRY_DAYS = 30;

const requestQueue = [];
let isProcessingQueue = false;
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 500;
const MAX_CONCURRENT_REQUESTS = 5;
let activeRequests = 0;
let rateLimitResetTime = 0;

let observer = null;

let extensionEnabled = true;
const TOGGLE_KEY = 'extension_enabled';
const DEFAULT_ENABLED = true;

const processingUsernames = new Set();

async function loadEnabledState() {
  try {
    const result = await chrome.storage.local.get([TOGGLE_KEY]);
    extensionEnabled = result[TOGGLE_KEY] !== undefined ? result[TOGGLE_KEY] : DEFAULT_ENABLED;
    console.log('Extension enabled:', extensionEnabled);
  } catch (error) {
    console.error('Error loading enabled state:', error);
    extensionEnabled = DEFAULT_ENABLED;
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'extensionToggle') {
    extensionEnabled = request.enabled;
    console.log('Extension toggled:', extensionEnabled);

    if (extensionEnabled) {
      setTimeout(() => {
        processUsernames();
      }, 500);
    } else {
      removeAllFlags();
    }
  }
});

async function loadCache() {
  try {
    if (!chrome.runtime?.id) {
      console.log('Extension context invalidated, skipping cache load');
      return;
    }

    const result = await chrome.storage.local.get(CACHE_KEY);
    if (result[CACHE_KEY]) {
      const cached = result[CACHE_KEY];
      const now = Date.now();

      for (const [username, data] of Object.entries(cached)) {
        if (data.expiry && data.expiry > now && data.location !== null) {
          locationCache.set(username, data.location);
        }
      }
      console.log(`Loaded ${locationCache.size} cached locations (excluding null entries)`);
    }
  } catch (error) {
    if (error.message?.includes('Extension context invalidated') ||
      error.message?.includes('message port closed')) {
      console.log('Extension context invalidated, cache load skipped');
    } else {
      console.error('Error loading cache:', error);
    }
  }
}

async function saveCache() {
  try {
    if (!chrome.runtime?.id) {
      console.log('Extension context invalidated, skipping cache save');
      return;
    }

    const cacheObj = {};
    const now = Date.now();
    const expiry = now + (CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    for (const [username, location] of locationCache.entries()) {
      cacheObj[username] = {
        location: location,
        expiry: expiry,
        cachedAt: now
      };
    }

    await chrome.storage.local.set({ [CACHE_KEY]: cacheObj });
  } catch (error) {
    if (error.message?.includes('Extension context invalidated') ||
      error.message?.includes('message port closed')) {
      console.log('Extension context invalidated, cache save skipped');
    } else {
      console.error('Error saving cache:', error);
    }
  }
}

async function saveCacheEntry(username, location) {
  if (!chrome.runtime?.id) {
    console.log('Extension context invalidated, skipping cache entry save');
    return;
  }

  locationCache.set(username, location);
  if (!saveCache.timeout) {
    saveCache.timeout = setTimeout(async () => {
      await saveCache();
      saveCache.timeout = null;
    }, 5000);
  }
}

function injectPageScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('pageScript.js');
  script.onload = function () {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === '__rateLimitInfo') {
      rateLimitResetTime = event.data.resetTime;
      const waitTime = event.data.waitTime;
      console.log(`Rate limit detected. Will resume requests in ${Math.ceil(waitTime / 1000 / 60)} minutes`);
    }
  });
}

async function processRequestQueue() {
  if (isProcessingQueue || requestQueue.length === 0) {
    return;
  }

  if (rateLimitResetTime > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now < rateLimitResetTime) {
      const waitTime = (rateLimitResetTime - now) * 1000;
      console.log(`Rate limited. Waiting ${Math.ceil(waitTime / 1000 / 60)} minutes...`);
      setTimeout(processRequestQueue, Math.min(waitTime, 60000));
      return;
    } else {
      rateLimitResetTime = 0;
    }
  }

  isProcessingQueue = true;

  while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;

    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
      await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest));
    }

    const { screenName, resolve, reject } = requestQueue.shift();
    activeRequests++;
    lastRequestTime = Date.now();

    makeLocationRequest(screenName)
      .then(location => {
        resolve(location);
      })
      .catch(error => {
        reject(error);
      })
      .finally(() => {
        activeRequests--;
        setTimeout(processRequestQueue, 200);
      });
  }

  isProcessingQueue = false;
}

function makeLocationRequest(screenName) {
  return new Promise((resolve, reject) => {
    const requestId = Date.now() + Math.random();

    const handler = (event) => {
      if (event.source !== window) return;

      if (event.data &&
        event.data.type === '__locationResponse' &&
        event.data.screenName === screenName &&
        event.data.requestId === requestId) {
        window.removeEventListener('message', handler);
        const location = event.data.location;
        const isRateLimited = event.data.isRateLimited || false;

        if (!isRateLimited) {
          saveCacheEntry(screenName, location || null);
        } else {
          console.log(`Not caching null for ${screenName} due to rate limit`);
        }

        resolve(location || null);
      }
    };
    window.addEventListener('message', handler);

    window.postMessage({
      type: '__fetchLocation',
      screenName,
      requestId
    }, '*');

    setTimeout(() => {
      window.removeEventListener('message', handler);
      console.log(`Request timeout for ${screenName}, not caching`);
      resolve(null);
    }, 10000);
  });
}

async function getUserLocation(screenName) {
  if (locationCache.has(screenName)) {
    const cached = locationCache.get(screenName);
    if (cached !== null) {
      console.log(`Using cached location for ${screenName}: ${cached}`);
      return cached;
    } else {
      console.log(`Found null in cache for ${screenName}, will retry API call`);
      locationCache.delete(screenName);
    }
  }

  console.log(`Queueing API request for ${screenName}`);
  return new Promise((resolve, reject) => {
    requestQueue.push({ screenName, resolve, reject });
    processRequestQueue();
  });
}

function extractUsername(element) {
  const usernameElement = element.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
  if (usernameElement) {
    const links = usernameElement.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const href = link.getAttribute('href');
      const match = href.match(/^\/([^\/\?]+)/);
      if (match && match[1]) {
        const username = match[1];
        const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings', 'bookmarks', 'lists', 'communities', 'hashtag', 'who_to_follow', 'topics', 'verified-orgs-signup'];
        if (!excludedRoutes.includes(username) &&
          !username.startsWith('hashtag') &&
          !username.startsWith('search') &&
          username.length > 0 &&
          username.length < 20) {
          return username;
        }
      }
    }
  }

  const allLinks = element.querySelectorAll('a[href^="/"]');
  const seenUsernames = new Set();

  for (const link of allLinks) {
    const href = link.getAttribute('href');
    if (!href) continue;

    const match = href.match(/^\/([^\/\?]+)/);
    if (!match || !match[1]) continue;

    const potentialUsername = match[1];

    if (seenUsernames.has(potentialUsername)) continue;
    seenUsernames.add(potentialUsername);

    const excludedRoutes = ['home', 'explore', 'notifications', 'messages', 'i', 'compose', 'search', 'settings', 'bookmarks', 'lists', 'communities', 'hashtag', 'who_to_follow', 'topics', 'verified-orgs-signup'];
    if (excludedRoutes.some(route => potentialUsername === route || potentialUsername.startsWith(route))) {
      continue;
    }

    if (potentialUsername.includes('status') || potentialUsername.match(/^\d+$/)) {
      continue;
    }

    const text = link.textContent?.trim() || '';
    const linkText = text.toLowerCase();
    const usernameLower = potentialUsername.toLowerCase();

    if (text.startsWith('@')) {
      return potentialUsername;
    }

    if (linkText === usernameLower || linkText === `@${usernameLower}`) {
      return potentialUsername;
    }

    const parent = link.closest('[data-testid="UserName"], [data-testid="User-Name"]');
    if (parent) {
      if (potentialUsername.length > 0 && potentialUsername.length < 20 && !potentialUsername.includes('/')) {
        return potentialUsername;
      }
    }

    if (text && text.trim().startsWith('@')) {
      const atUsername = text.trim().substring(1);
      if (atUsername === potentialUsername) {
        return potentialUsername;
      }
    }
  }

  const textContent = element.textContent || '';
  const atMentionMatches = textContent.matchAll(/@([a-zA-Z0-9_]+)/g);
  for (const match of atMentionMatches) {
    const username = match[1];
    const link = element.querySelector(`a[href="/${username}"], a[href^="/${username}?"]`);
    if (link) {
      const isInUserNameContainer = link.closest('[data-testid="UserName"], [data-testid="User-Name"]');
      if (isInUserNameContainer) {
        return username;
      }
    }
  }

  return null;
}

function findHandleSection(container, screenName) {
  return Array.from(container.querySelectorAll('div')).find(div => {
    const link = div.querySelector(`a[href="/${screenName}"]`);
    if (link) {
      const text = link.textContent?.trim();
      return text === `@${screenName}`;
    }
    return false;
  });
}

function createLoadingShimmer() {
  const shimmer = document.createElement('span');
  shimmer.setAttribute('data-twitter-flag-shimmer', 'true');
  shimmer.style.display = 'inline-block';
  shimmer.style.width = '20px';
  shimmer.style.height = '16px';
  shimmer.style.marginLeft = '4px';
  shimmer.style.marginRight = '4px';
  shimmer.style.verticalAlign = 'middle';
  shimmer.style.borderRadius = '2px';
  shimmer.style.background = 'linear-gradient(90deg, rgba(113, 118, 123, 0.2) 25%, rgba(113, 118, 123, 0.4) 50%, rgba(113, 118, 123, 0.2) 75%)';
  shimmer.style.backgroundSize = '200% 100%';
  shimmer.style.animation = 'shimmer 1.5s infinite';

  if (!document.getElementById('twitter-flag-shimmer-style')) {
    const style = document.createElement('style');
    style.id = 'twitter-flag-shimmer-style';
    style.textContent = `
      @keyframes shimmer {
        0% {
          background-position: -200% 0;
        }
        100% {
          background-position: 200% 0;
        }
      }
    `;
    document.head.appendChild(style);
  }

  if (!document.getElementById('twitter-flag-tooltip-style')) {
    const style = document.createElement('style');
    style.id = 'twitter-flag-tooltip-style';
    style.textContent = `
      .twitter-flag-tooltip {
        position: absolute;
        background: rgba(0, 0, 0, 0.8);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: #fff;
        padding: 8px 12px;
        border-radius: 8px;
        font-size: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        z-index: 9999;
        pointer-events: none;
        opacity: 0;
        transform: translateY(10px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.1);
        max-width: 200px;
        text-align: center;
      }
      .twitter-flag-tooltip.visible {
        opacity: 1;
        transform: translateY(0);
      }
      .twitter-flag-tooltip .tooltip-location {
        font-weight: bold;
        margin-bottom: 4px;
        display: block;
      }
      .twitter-flag-tooltip .tooltip-author {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.7);
        display: block;
      }
    `;
    document.head.appendChild(style);
  }

  return shimmer;
}

async function addFlagToUsername(usernameElement, screenName) {
  if (usernameElement.dataset.flagAdded === 'true') {
    return;
  }

  if (processingUsernames.has(screenName)) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (usernameElement.dataset.flagAdded === 'true') {
      return;
    }
    usernameElement.dataset.flagAdded = 'waiting';
    return;
  }

  usernameElement.dataset.flagAdded = 'processing';
  processingUsernames.add(screenName);

  let userNameContainer = usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');

  if (!userNameContainer && (usernameElement.getAttribute('data-testid') === 'UserName' || usernameElement.getAttribute('data-testid') === 'User-Name')) {
    userNameContainer = usernameElement;
  }

  const shimmerSpan = createLoadingShimmer();
  let shimmerInserted = false;

  if (userNameContainer) {
    const handleSection = findHandleSection(userNameContainer, screenName);
    if (handleSection && handleSection.parentNode) {
      try {
        handleSection.parentNode.insertBefore(shimmerSpan, handleSection);
        shimmerInserted = true;
      } catch (e) {
        try {
          userNameContainer.appendChild(shimmerSpan);
          shimmerInserted = true;
        } catch (e2) {
          console.log('Failed to insert shimmer');
        }
      }
    } else {
      try {
        userNameContainer.appendChild(shimmerSpan);
        shimmerInserted = true;
      } catch (e) {
        console.log('Failed to insert shimmer');
      }
    }
  }

  try {
    console.log(`Processing flag for ${screenName}...`);

    const location = await getUserLocation(screenName);
    console.log(`Location for ${screenName}:`, location);

    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }

    if (!location) {
      console.log(`No location found for ${screenName}, marking as failed`);
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

    const countryCode = getCountryCode(location);
    if (!countryCode) {
      console.log(`No country code found for location: ${location}`);
      if (shimmerInserted && shimmerSpan.parentNode) {
        shimmerSpan.remove();
      }
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

    console.log(`Found country code ${countryCode} for ${screenName} (${location})`);

    let usernameLink = null;

    const containerForLink = userNameContainer || usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');

    if (containerForLink) {
      const containerLinks = containerForLink.querySelectorAll('a[href^="/"]');
      for (const link of containerLinks) {
        const text = link.textContent?.trim();
        const href = link.getAttribute('href');
        const match = href.match(/^\/([^\/\?]+)/);

        if (match && match[1] === screenName) {
          if (text === `@${screenName}` || text === screenName) {
            usernameLink = link;
            break;
          }
        }
      }
    }

    if (!usernameLink && containerForLink) {
      const containerLinks = containerForLink.querySelectorAll('a[href^="/"]');
      for (const link of containerLinks) {
        const text = link.textContent?.trim();
        if (text === `@${screenName}`) {
          usernameLink = link;
          break;
        }
      }
    }

    if (!usernameLink) {
      const links = usernameElement.querySelectorAll('a[href^="/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        const text = link.textContent?.trim();
        if ((href === `/${screenName}` || href.startsWith(`/${screenName}?`)) &&
          (text === `@${screenName}` || text === screenName)) {
          usernameLink = link;
          break;
        }
      }
    }

    if (!usernameLink) {
      const links = usernameElement.querySelectorAll('a[href^="/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        const match = href.match(/^\/([^\/\?]+)/);
        if (match && match[1] === screenName) {
          const hasVerificationBadge = link.closest('[data-testid="User-Name"]')?.querySelector('[data-testid="icon-verified"]');
          if (!hasVerificationBadge || link.textContent?.trim() === `@${screenName}`) {
            usernameLink = link;
            break;
          }
        }
      }
    }

    if (!usernameLink) {
      console.error(`Could not find username link for ${screenName}`);
      console.error('Available links in container:', Array.from(usernameElement.querySelectorAll('a[href^="/"]')).map(l => ({
        href: l.getAttribute('href'),
        text: l.textContent?.trim()
      })));
      if (shimmerInserted && shimmerSpan.parentNode) {
        shimmerSpan.remove();
      }
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

    console.log(`Found username link for ${screenName}:`, usernameLink.href, usernameLink.textContent?.trim());

    const existingFlag = usernameElement.querySelector('[data-twitter-flag]');
    if (existingFlag) {
      if (shimmerInserted && shimmerSpan.parentNode) {
        shimmerSpan.remove();
      }
      usernameElement.dataset.flagAdded = 'true';
      return;
    }

    const flagImg = document.createElement('img');
    flagImg.src = `https://flagcdn.com/20x15/${countryCode}.png`;
    flagImg.srcset = `https://flagcdn.com/40x30/${countryCode}.png 2x, https://flagcdn.com/60x45/${countryCode}.png 3x`;
    flagImg.alt = location;
    flagImg.setAttribute('data-twitter-flag', 'true');
    flagImg.style.marginLeft = '4px';
    flagImg.style.marginRight = '4px';
    flagImg.style.display = 'inline-block';
    flagImg.style.verticalAlign = 'middle';
    flagImg.style.height = '15px';
    flagImg.style.width = '20px';
    flagImg.style.minWidth = '20px';
    flagImg.style.maxWidth = '20px';
    flagImg.style.objectFit = 'contain';
    flagImg.style.borderRadius = '2px';

    let containerForFlag = userNameContainer;
    if (!containerForFlag) {
      containerForFlag = usernameElement.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
    }

    if (!containerForFlag && (usernameElement.getAttribute('data-testid') === 'UserName' || usernameElement.getAttribute('data-testid') === 'User-Name')) {
      containerForFlag = usernameElement;
    }

    if (!containerForFlag) {
      console.error(`Could not find UserName container for ${screenName}`);
      if (shimmerInserted && shimmerSpan.parentNode) {
        shimmerSpan.remove();
      }
      usernameElement.dataset.flagAdded = 'failed';
      return;
    }

    const verificationBadge = containerForFlag.querySelector('[data-testid="icon-verified"]');

    const handleSection = findHandleSection(containerForFlag, screenName);

    let inserted = false;

    if (handleSection && handleSection.parentNode === containerForFlag) {
      try {
        containerForFlag.insertBefore(flagImg, handleSection);
        inserted = true;
        console.log(`✓ Inserted flag before handle section for ${screenName}`);
      } catch (e) {
        console.log('Failed to insert before handle section:', e);
      }
    }

    if (!inserted && handleSection && handleSection.parentNode) {
      try {
        const handleParent = handleSection.parentNode;
        if (handleParent !== containerForFlag && handleParent.parentNode) {
        } else if (handleParent === containerForFlag) {
          containerForFlag.insertBefore(flagImg, handleSection);
          inserted = true;
          console.log(`✓ Inserted flag before handle section (direct child) for ${screenName}`);
        }
      } catch (e) {
        console.log('Failed to insert before handle parent:', e);
      }
    }

    if (!inserted && handleSection) {
      try {
        const displayNameLink = containerForFlag.querySelector('a[href^="/"]');
        if (displayNameLink) {
          const displayNameContainer = displayNameLink.closest('div');
          if (displayNameContainer && displayNameContainer.parentNode) {
            if (displayNameContainer.parentNode === handleSection.parentNode) {
              displayNameContainer.parentNode.insertBefore(flagImg, handleSection);
              inserted = true;
              console.log(`✓ Inserted flag between display name and handle (siblings) for ${screenName}`);
            } else {
              displayNameContainer.parentNode.insertBefore(flagImg, displayNameContainer.nextSibling);
              inserted = true;
              console.log(`✓ Inserted flag after display name container for ${screenName}`);
            }
          }
        }
      } catch (e) {
        console.log('Failed to insert after display name:', e);
      }
    }

    if (!inserted) {
      try {
        containerForFlag.appendChild(flagImg);
        inserted = true;
        console.log(`✓ Inserted flag at end of UserName container for ${screenName}`);
      } catch (e) {
        console.error('Failed to append flag to User-Name container:', e);
      }
    }

    if (inserted) {
      usernameElement.dataset.flagAdded = 'true';
      console.log(`✓ Successfully added flag ${countryCode} for ${screenName} (${location})`);

      let tooltip = null;

      flagImg.addEventListener('mouseenter', (e) => {
        if (!tooltip) {
          tooltip = document.createElement('div');
          tooltip.className = 'twitter-flag-tooltip';
          tooltip.innerHTML = `
            <span class="tooltip-location">${location}</span>
            <span class="tooltip-author">by ayouboto</span>
          `;
          document.body.appendChild(tooltip);
        }

        const rect = flagImg.getBoundingClientRect();
        const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
        const scrollLeft = window.pageXOffset || document.documentElement.scrollLeft;

        tooltip.style.top = `${rect.top + scrollTop - tooltip.offsetHeight - 8}px`;
        tooltip.style.left = `${rect.left + scrollLeft + (rect.width / 2) - (tooltip.offsetWidth / 2)}px`;

        requestAnimationFrame(() => {
          tooltip.classList.add('visible');
        });
      });

      flagImg.addEventListener('mouseleave', () => {
        if (tooltip) {
          tooltip.classList.remove('visible');
          setTimeout(() => {
            if (tooltip && tooltip.parentNode) {
              tooltip.parentNode.removeChild(tooltip);
              tooltip = null;
            }
          }, 200);
        }
      });
    } else {
      console.error(`Failed to insert flag for ${screenName}`);
      usernameElement.dataset.flagAdded = 'failed';
    }
  } catch (error) {
    console.error(`Error adding flag for ${screenName}:`, error);
    if (shimmerInserted && shimmerSpan.parentNode) {
      shimmerSpan.remove();
    }
    usernameElement.dataset.flagAdded = 'failed';
  } finally {
    processingUsernames.delete(screenName);
  }
}

function removeAllFlags() {
  const flags = document.querySelectorAll('[data-twitter-flag]');
  flags.forEach(flag => flag.remove());

  const shimmers = document.querySelectorAll('[data-twitter-flag-shimmer]');
  shimmers.forEach(shimmer => shimmer.remove());

  const processedElements = document.querySelectorAll('[data-flag-added]');
  processedElements.forEach(el => {
    delete el.dataset.flagAdded;
  });

  locationCache.clear();
  processingUsernames.clear();
}

function processUsernames() {
  if (!extensionEnabled) return;

  const articles = document.querySelectorAll('article');
  articles.forEach(article => {
    const usernameElements = article.querySelectorAll('[data-testid="User-Name"]');
    usernameElements.forEach(element => {
      if (element.dataset.flagAdded) return;

      const screenName = extractUsername(element);
      if (screenName) {
        addFlagToUsername(element, screenName);
      }
    });
  });

  const profileHeaders = document.querySelectorAll('[data-testid="UserName"]');
  profileHeaders.forEach(element => {
    if (element.dataset.flagAdded) return;

    const screenName = extractUsername(element);
    if (screenName) {
      addFlagToUsername(element, screenName);
    }
  });
}

function init() {
  loadEnabledState().then(() => {
    loadCache();
    injectPageScript();

    observer = new MutationObserver((mutations) => {
      if (!extensionEnabled) return;

      let shouldProcess = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          shouldProcess = true;
          break;
        }
      }

      if (shouldProcess) {
        processUsernames();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    processUsernames();

    setInterval(processUsernames, 2000);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
