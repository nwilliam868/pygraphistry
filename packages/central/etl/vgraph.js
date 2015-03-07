var Q = require('q');
var _ = require('underscore');
var fs = require('fs');
var debug = require('debug')('graphistry:etl:vgraph');
var pb = require('protobufjs');
var zlib = require('zlib');
var path = require('path');

var builder = null;
var pb_root = null;
var protoFile = path.resolve(__dirname, '../node_modules/graph-viz/js/libs/graph_vector.proto');

pb.loadProtoFile(protoFile, function (err, builder_) {
    if (err) {
        debug('error: could not build proto', err, err.stack);
        return;
    } else {
        builder = builder_;
        pb_root = builder.build();
    }
});

// String * String -> Vector
function makeVector(name, value, target) {
    var vector;

    if (value !== null && value !== undefined
            && (typeof(value) !== 'string' || value.trim() !== "")
            && !isNaN(Number(value))) {
        debug('make col number', name, [value]);
        vector = new pb_root.VectorGraph.DoubleAttributeVector();
        vector.dest = 'double_vectors';
        vector.transform = parseFloat;
        vector.default = NaN;
    } else {
        debug('make col string', name, [value]);
        vector = new pb_root.VectorGraph.StringAttributeVector();
        vector.dest = 'string_vectors';
        vector.transform = function (x) { return String(x); };
        vector.default = '';
    }

    vector.name = name;
    vector.target = target;
    vector.values = [];
    vector.map = {};
    return vector;
}

// JSON -> [String * Vector]
function getAttributeVectors(entry, target) {
    return _.object(_.map(_.keys(entry), function (key) {
        var vec = makeVector(key, entry[key], target);
        return [key, vec];
    }));
}

// Simple (and dumb) conversion of JSON edge lists to VGraph
// JSON * String * String * String -> VGraph
function fromEdgeList(elist, nlabels, srcField, dstField, idField,  name) {
    var node2Idx = {};
    var idx2Node = {};
    var nodeCount = 0;
    var edges = [];
    // For detecting duplicate edges.
    var edgeMap = {}

    function addNode(node) {
        if (!(node in node2Idx)) {
            idx2Node[nodeCount] = node;
            node2Idx[node] = nodeCount;
            nodeCount++;
        }
    }

    function warnIfDuplicated(src, dst) {
        var dsts = edgeMap[src] || {};
        if (dst in dsts) {
            console.warn('Edge %s -> %s is duplicated', src, dst);
        }

        var srcs = edgeMap[dst] || {};
        if (src in srcs) {
            console.warn('Edge %s <-> %s has both directions', src, dst)
        }
    }

    function addEdge(node0, node1, entry) {
        var e = new pb_root.VectorGraph.Edge();
        e.src = node2Idx[node0];
        e.dst = node2Idx[node1];
        edges.push(e);

        warnIfDuplicated(node0, node1);
        var dsts = edgeMap[node0] || {};
        dsts[node1] = true;
        edgeMap[node0] = dsts;
    }

    function addAttributes(vectors, entry) {
        _.each(entry, function (val, key) {
            var vector = vectors[key];
            vector.values.push(vector.transform(val));
        });
    }

    var evectors = getAttributeVectors(elist[0] || {},
                                       pb_root.VectorGraph.AttributeTarget.EDGE);
    var nvectors = getAttributeVectors(nlabels[0] || {},
                                       pb_root.VectorGraph.AttributeTarget.VERTEX);

    _.each(elist, function (entry) {
        var node0 = entry[srcField];
        var node1 = entry[dstField];
        addNode(node0);
        addNode(node1);
        addEdge(node0, node1);
        // Assumes that all edges have the same attributes.
        addAttributes(evectors, entry);
    });

    _.each(nlabels, addAttributes.bind('', nvectors));

    var vg = new pb_root.VectorGraph();
    vg.version = 0;
    vg.name = name;
    vg.type = pb_root.VectorGraph.GraphType.DIRECTED;
    vg.nvertices = nodeCount;
    vg.nedges = edges.length;
    vg.edges = edges;

    _.each(_.omit(evectors, srcField, dstField), function (vector) {
        vg[vector.dest].push(vector);
    });

    _.each(_.omit(nvectors, '_mkv_child', '_timediff'), function (vector) {
        vg[vector.dest].push(vector);
    });

    //debug('VectorGraph', vg);
    debug('VectorGraph done');

    return vg;
}

module.exports = {
    fromEdgeList: fromEdgeList
};
