// @ts-check
/// <reference types="node" />
/// <reference types="knex" />

'use strict';

const url = require('url');
const intersection = require('lodash.intersection');
const pick = require('lodash.pick');
const isEmpty = require('lodash.isempty');
const cloneDeep = require('lodash.clonedeep');
const { normalizeUrl, normalizeUrlRaw, simpleHostnameValidation } = require('../utils/url-tools');
const Entry = require('./entry');

/**
 * @typedef EntryTarget
 * @property {string} [site]
 * @property {string} [url]
 * @property {string} [path]
 * @property {true} [example]
 */

class Entries {
  /**
   * @param {object} options
   * @param {import('knex')} options.knex
   * @param {object} options.requestBroker
   */
  constructor ({ knex, requestBroker }) {
    if (!knex || typeof knex !== 'function') { throw new TypeError('Expected a knex function'); }
    if (!requestBroker || typeof requestBroker !== 'object') { throw new TypeError('Expected a requestBroker object'); }

    this.knex = knex;
    this.requestBroker = requestBroker;
  }
}

Entries.prototype._buildMentionTree = function (mentions) {
  const mentionsById = {};
  const result = [];

  mentions.forEach(mention => {
    mentionsById[mention.id] = mention;
  });

  mentions.forEach(mention => {
    mention.parents.forEach(parentId => {
      if (parentId === 0) {
        return;
      }

      let existing = [mention];
      let circular = false;

      const check = (mention) => mention.id === parentId;

      while (existing.length) {
        if (existing.some(check)) {
          circular = true;
          break;
        }
        existing = existing.reduce((submentions, mention) => submentions.concat(mention.mentions || []), []);
      }

      if (!circular) {
        mentionsById[parentId].mentions = mentionsById[parentId].mentions || [];
        mentionsById[parentId].mentions.push(mention);
      }
    });
  });

  mentions.forEach(mention => {
    if (mention.parents.includes(0)) {
      result.push(mention);
    }

    delete mention.id;
    delete mention.parents;
  });

  return result;
};

Entries.prototype._resolveDerivedData = function (data) {
  if (data.type !== 'mention') {
    const matchingInteractionTargets = intersection(
      data.targets.map(url => normalizeUrl(url)),
      data.interactions.map(url => normalizeUrl(url))
    );

    data.interactionTarget = (matchingInteractionTargets.length !== 0);
  }

  return data;
};

Entries.prototype._distillMention = function (row) {
  if (!row || !row.data) {
    return false;
  }

  let data = pick(row.data, ['url', 'name', 'published', 'summary', 'author', 'interactionType', 'interactions']);

  data.author = pick(data.author || {}, ['name', 'photo', 'url']);

  data.url = data.url || row.url;
  data.targets = row.targets || [];
  data.type = row.type || data.interactionType || 'mention';
  data.interactions = data.interactions || [];
  data.parents = row.parents;
  data.id = row.id;

  if (row.removedTargets || row.removedTargets === null) {
    data.removedTargets = row.removedTargets || [];
  }

  data = this._resolveDerivedData(data);

  delete data.interactionType;

  return data;
};

Entries.prototype._distillTargets = function (mention, target) {
  const isTarget = (checkTarget) => {
    const checkNormalized = normalizeUrl(checkTarget);
    const checkSite = url.parse(checkNormalized).hostname;

    let result = false;

    if (!isEmpty(target.url)) {
      result = [].concat(target.url).some(targetUrl => checkNormalized === normalizeUrl(targetUrl));
    }
    if (!result && !isEmpty(target.site)) {
      result = [].concat(target.site).some(targetSite => checkSite === targetSite);
    }
    if (!result && !isEmpty(target.path)) {
      result = [].concat(target.path).some(targetPath => checkNormalized.indexOf(targetPath) === 0);
    }

    return result;
  };

  mention = cloneDeep(mention);
  mention.targets = (mention.targets || []).filter(target => isTarget(target));
  mention.removedTargets = (mention.removedTargets || []).filter(target => isTarget(target));

  mention = this._resolveDerivedData(mention);

  return mention;
};

/**
 * @param {EntryTarget} target
 * @param {object} [options]
 * @param {boolean} [options.interactions]
 */
Entries.prototype._getTargetQuery = function (target, { interactions } = {}) {
  const knex = this.knex;
  let query = knex('mentions').distinct('eid');

  query = query.where(function () {
    if (!isEmpty(target.url)) {
      // TODO: Validate URL?
      this.orWhereIn('mentions.normalizedUrl', [].concat(target.url).map(url => normalizeUrl(url)));
    }
    if (!isEmpty(target.site)) {
      this.orWhereIn('mentions.hostname', [].concat(target.site).map(hostname => {
        if (!simpleHostnameValidation.test(hostname)) {
          return undefined;
        }
        try {
          return normalizeUrlRaw('http://' + hostname + '/').hostname;
        } catch (err) {
          return undefined;
        }
      }));
    }
    if (!isEmpty(target.path)) {
      [].concat(target.path).forEach(path => {
        this.orWhere('normalizedUrl', 'like', normalizeUrl(path).replace(/\\/g, '').replace(/[%_]/g, '\\%') + '%');
      });
    }
  });

  query = query.where('mentions.removed', false);

  if (interactions === true) {
    query = query.where('interaction', true);
  }

  return query;
};

// TODO: Should be able to return an actual Entry object
Entries.prototype.get = function (entryId) {
  const knex = this.knex;

  const targets = knex('mentions').as('targets')
    .select(knex.raw('array_agg(mentions.url)'))
    .whereRaw('mentions.eid = entries.id')
    .where('removed', false);

  const removed = knex('mentions').as('removedTargets')
    .select(knex.raw('array_agg(mentions.url)'))
    .whereRaw('mentions.eid = entries.id')
    .where('removed', true);

  const query = knex('entries')
    .first(
      'entries.url as url',
      'data',
      'type',
      targets,
      removed
    )
    .where('id', entryId);

  return query.then(row => this._distillMention(row));
};

// TODO: Should be able to return actual Entry objects
// TODO: Should be able to stream the result back
/**
 * @param {EntryTarget|string} target
 * @param {object} [options]
 * @param {boolean} [options.distillTargets]
 * @param {boolean} [options.interactions]
 * @param {'desc'} [options.sort]
 * @returns {Promise<Object<string,any>[]>}
 */
Entries.prototype.queryByTarget = function (target = {}, options = {}) {
  const knex = this.knex;

  const {
    distillTargets,
    interactions,
    sort
  } = options;

  if (typeof target === 'string') {
    target = { url: target };
  }

  if (target.example !== undefined) {
    return Promise.resolve(require('../utils/sample-data').mentions(14, options)).then(mentions =>
      mentions.map(example =>
        this._distillMention({
          data: example,
          type: example.type,
          targets: example.targets
        })
      )
    ).catch(err => {
      console.warn(err);
      console.log(err.stack);
      return [];
    });
  } else if (!target.url && !target.site && !target.path) {
    return Promise.resolve([]);
  }

  let entryQuery = knex('entries');
  let query = this._getTargetQuery(target, { interactions });
  const interactionTypes = ['like', 'repost'];

  entryQuery = entryQuery.select(
    'entries.url as url',
    'data',
    'type',
    knex.raw('array_agg(allmentions.url) as targets'),
    knex.raw('array_agg(allmentions.parent) as parents'),
    'id'
  )
    .innerJoin('allmentions', 'entries.id', 'allmentions.eid')
    .groupBy('entries.id')
    .orderBy('published', sort === 'desc' ? 'desc' : 'asc');

  if (interactions === true) {
    entryQuery = entryQuery.whereIn('type', interactionTypes);
  } else if (interactions === false) {
    entryQuery = entryQuery.where(function () {
      this.whereNotIn('type', interactionTypes);
      this.orWhereNull('type');
    });
  }

  query = query.select(knex.raw('0'), 'normalizedUrl', 'url').union(function () {
    this.select('mentions.eid', 'allmentions.eid', 'mentions.normalizedUrl', 'mentions.url')
      .from('mentions')
      .innerJoin('entries', 'entries.normalizedUrl', 'mentions.normalizedUrl')
      .innerJoin('allmentions', 'entries.id', 'allmentions.eid')
      .where('mentions.removed', false);
  });

  const fullQuery = knex.raw('WITH RECURSIVE "allmentions"("eid", "parent", "normalizedUrl", "url") AS (' + query + ') ' + entryQuery + '');

  return Promise.resolve(fullQuery)
    .then(result =>
      result.rows
        .map(row => this._distillMention(row))
        .map(row => distillTargets ? this._distillTargets(row, target) : row)
    )
    .then(mentions => this._buildMentionTree(mentions));
  // TODO: Cache the result so the last seen positive response can be returned if the database goes away
};

Entries.prototype.create = function (entryUrl, data) {
  return new Entry(entryUrl, data, {
    knex: this.knex,
    requestBroker: this.requestBroker,
    entryCollection: this
  });
};

module.exports = Entries;
