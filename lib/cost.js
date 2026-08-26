const fs = require('fs');
const path = require('path');

const pricing = JSON.parse(fs.readFileSync(path.join(__dirname, 'pricing.json'), 'utf8'));

function priceFor(route, model) {
  return pricing[`${route}/${model}`] || null;
}

/**
 * Estimate a session's cost by splitting its aggregate token totals across
 * whichever models it actually used, weighted by each model's share of
 * requests within that session (the log doesn't carry a per-request token
 * breakdown, only per-session totals, so this is a weighted approximation).
 */
function estimateSessionCost(tokenUsage, requestCountsByModel) {
  const totalRequests = Object.values(requestCountsByModel).reduce((a, b) => a + b, 0);
  if (totalRequests === 0) return { knownUsd: 0, unknownShare: 0, byModel: [] };

  let knownUsd = 0;
  let unknownRequests = 0;
  const byModel = [];

  for (const [key, count] of Object.entries(requestCountsByModel)) {
    const weight = count / totalRequests;
    const [route, ...modelParts] = key.split('/');
    const model = modelParts.join('/');
    const price = priceFor(route, model);
    const tokens = {
      input: tokenUsage.input * weight,
      output: tokenUsage.output * weight,
      cacheRead: tokenUsage.cacheRead * weight,
      cacheWrite: tokenUsage.cacheWrite * weight,
    };
    if (!price) {
      unknownRequests += count;
      byModel.push({ key, requests: count, weight, usd: null, tokens });
      continue;
    }
    const usd = (tokens.input * price.input + tokens.output * price.output
      + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / 1_000_000;
    knownUsd += usd;
    byModel.push({ key, requests: count, weight, usd, tokens });
  }

  return { knownUsd, unknownShare: unknownRequests / totalRequests, byModel };
}

module.exports = { pricing, priceFor, estimateSessionCost };
