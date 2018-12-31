"use strict";

const semver = require('semver');
//const assert = require('assert');
const zluxUtil = require('./util');

module.exports = DependencyGraph;

const logger = zluxUtil.loggers.bootstrapLogger

/**
 * Checks if all plugin dependencies are met, including versions.
 * Sorts the plugins so that they can be installed in that order.
 */
function DependencyGraph(initialPlugins) {
  this.pluginsById = {};
  for (const p of initialPlugins) {
    this.addPlugin(p);
  }
}

DependencyGraph.prototype = {
  constructor: DependencyGraph,
  
  pluginsById: null,
  
  addPlugin(plugin) {
    logger.debug(`Adding plugin ${plugin.identifier}`);
    this.pluginsById[plugin.identifier] = plugin;
  },
  
  /**
   * "n -> m" means "n is a dependency of m". Note that this is the direct 
   * opposite of an import, i.e. "m imports n".
   * 
   * This is the graph of the plugins' desires based on imports in the defs:
   * if there's an edge "n -> m" here then we know that plugin m actually 
   * exists, but n might either exist or just be m's dream.
   */
  _buildGraph() {
    const g = {};
    const brokenDeps = [];
    for (const plugin of Object.values(this.pluginsById)) {
      logger.debug("processing plugin ", plugin, "\n")
      const importerId = plugin.identifier;
      if (!g[importerId]) {
        g[importerId] = { 
            pluginId: importerId,
            deps: []
        };
      }
      if (!plugin.dataServices) {
        continue;
      }
      for (const service of plugin.dataServices) {
        if (service.type == 'import') {
          const serviceImport = service;
          const providerId = serviceImport.sourcePlugin;
          let providerNode = g[providerId];
          if (!providerNode) {
            providerNode = g[providerId] = { 
              pluginId: providerId,
              deps: []
            };
          }
          const depLink = {
            provider: providerId,
            service: serviceImport.sourceName,
            importer: importerId,
            alias: serviceImport.localName,
            requiredVersionRange: serviceImport.versionRange,
          };
          validateDep(depLink, this.pluginsById[providerId]);
          logger.debug('Found dependency: ', providerId, depLink)
          providerNode.deps.push(Object.freeze(depLink));
          if (depLink.valid) {
            serviceImport.version = depLink.actualVersion;
            logger.debug("resolved actual version for import ", serviceImport)
          } else {
            brokenDeps.push(depLink)
          }
        }
      }
    }
    return { 
      graph: g,
      brokenDeps
    }
  },
  
  /**
   * Separates all invalid imports into a separate object.
   * 
   * If m imports a service from n and it turns out to be impossible for some
   * reason (plugin/service n doesn't exist, wrong version) then m and the
   * entire subgraph reachable from m needs to be removed. It's not only m's
   * wish that cannot be fulfilled, but also everyone who depends on m cannot be
   * properly instantiated.
   */
  _removeBrokenPlugins(graphWithBrokenDeps) {
    logger.debug('graph: ', graphWithBrokenDeps)
    const rejects = {};
    const graph = graphWithBrokenDeps.graph;
    for (let brokenDep of graphWithBrokenDeps.brokenDeps) {
      visit(graph[brokenDep.importer], brokenDep.validationError);
    }
    function visit(pluginNode, validationError) {
      logger.debug('visiting broken node ', pluginNode)
      if (pluginNode.visited) {
        return;
      } 
      if (pluginNode.visiting) {
        //TODO deal with a circular dependency. Not really clear what to do,
        //perhaps, reject the entire cycle but leave the unaffected nodes there.
        //Implementing a cycle detection algorithm is a different story.
        //TODO good diagnostics
        throw new Error("circular dependency: " + pluginNode.pluginId);
      }
      pluginNode.valid = false;
      pluginNode.validationError = validationError;
      pluginNode.visiting = true;
      for (const dep of pluginNode.deps) {
        const importer = graph[dep.importer];
        logger.debug("following link: ", dep, ": ", importer)
        let error;
        if (!dep.valid) {
          error = dep.validationError;
        } else {
          error = {
            status: "REQUIRED_PLUGIN_FAILED_TO_LOAD",
            pluginId: dep.provider
          }
        }
        visit(importer, error);
      }
      rejects[pluginNode.pluginId] = pluginNode;
      pluginNode.visiting = false;
      pluginNode.visited = true;
    }
    for (const reject of Object.keys(rejects)) {
      delete graphWithBrokenDeps.graph[reject.pluginId];
    }
    return rejects;
  },
  
  /**
   * Produces a topologically sorted array of plugins. 
   * 
   * Note that the sorted list returned can contain "dream" plugins - those that 
   * were required but don't exist. The caller needs to filter them out (the
   * importers will of course be correctly rejected)
   * 
   */
  _toposort(graph) {
    logger.debug('graph: ', graph)
    const pluginsSorted = [];
    let time = 0;
    for (let importedPlugin of Object.values(graph)) {
      visit(importedPlugin, true);
    }
    return pluginsSorted;
    
    function visit(pluginNode) {
      logger.debug('visiting node ', pluginNode)
      if (pluginNode.visited) {
        return;
      } 
      if (pluginNode.visiting) {
        //TODO deal with a circular dependency. Not really clear what to do,
        //perhaps, reject the entire cycle but leave the unaffected nodes there.
        //Implementing a cycle detection algorithm is a different story.
        //TODO good diagnostics
        throw new Error("circular dependency: " + pluginNode.pluginId);
      }
      pluginNode.discoveryTime = ++time;
      pluginNode.visiting = true;
      for (const dep of pluginNode.deps) {
        visit(graph[dep.importer]);
      }
      pluginNode.visiting = false;
      pluginNode.visited = true;
      pluginNode.finishingTime = ++time;
      logger.debug(`${pluginNode.pluginId}: `
          + `${pluginNode.discoveryTime}/${pluginNode.finishingTime}`);
      //See the proof at the end of Cormen et al. (2001), 
      // "Section 22.4: Topological sort"
      //loop invariant derived from the proof
      //assert((pluginsSorted.length === 0) 
      //   || (pluginNode.finishingTime > pluginsSorted[0].finishingTime));
      pluginsSorted.unshift(pluginNode);
    } 
  },
  
  processImports() {
    const graphWithBrokenDeps = this._buildGraph();
    const rejects = this._removeBrokenPlugins(graphWithBrokenDeps);
    const pluginsSorted = this._toposort(graphWithBrokenDeps.graph);
    const pluginsSortedAndFiltered = [];
    const nonRejectedPlugins = {};
    for (const plugin of Object.values(this.pluginsById)) {
      if (!rejects[plugin.identifier]) {
        nonRejectedPlugins[plugin.identifier] = plugin;
      }
    }
    for (const node of pluginsSorted) {
      const plugin = nonRejectedPlugins[node.pluginId];
      if (plugin) {
        pluginsSortedAndFiltered.push(plugin);
      }
      delete nonRejectedPlugins[node.pluginId];
    }
    logger.debug("*** pluginsSorted: ", pluginsSortedAndFiltered)
    logger.debug("*** rejects: ", rejects)
    return {
      plugins: pluginsSortedAndFiltered,
      rejects: Object.values(rejects)
    }
  }
}

/**
 * Checks if the provider plugin (1) exists (2) contains a service that could
 * satisfy the import
 */
function validateDep(dep, providerPlugin) {
  let valid = false;
  let validationError;
  
  if (!providerPlugin) {
    valid = false;
    validationError = {
      status: "REQUIRED_PLUGIN_NOT_FOUND",
      pluginId: dep.provider
    }
  } else {
    let found = false;
    let foundAtDifferentVersion = false;
    for (const service of providerPlugin.dataServices) {
      if (service.name == dep.service) {
        if (service.type === "import") {
          validationError = {
            status: "IMPORTED_SERVICE_IS_AN_IMPORT",
            pluginId: providerPlugin.identifier,
            serviceName: service.name
          }
          found = true;
          break;
        } else if (!semver.satisfies(service.version, dep.requiredVersionRange)) {
          foundAtDifferentVersion = true;
        } else {
          valid = true;
          found = true;
          dep.actualVersion = service.version;
          break;
        }
      }
    }
    if (!found) {
      if (foundAtDifferentVersion) {
        validationError = {
          status: "REQUIRED_SERVICE_VERSION_NOT_FOUND",
          pluginId: providerPlugin.identifier,
          service: dep.service,
          requiredVersion: dep.requiredVersionRange
        }
      } else {
        validationError = {
          status: "REQUIRED_SERVICE_NOT_FOUND",
          pluginId: providerPlugin.identifier,
        }
      }
    }
  }
  dep.valid = valid;
  dep.validationError = validationError;
  logger.debug('dep.valid: ', dep.valid)
}
