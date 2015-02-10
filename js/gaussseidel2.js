'use strict'

var debug = require("debug")("graphistry:graph-viz:cl:gaussseidel")
var Q = require('q');
var _ = require('underscore');
var cljs = require('./cl.js');
var webcl = require('node-webcl');
var util = require('./util');
var Kernel = require('./kernel.js');

var argsType = {
    numPoints: cljs.types.uint_t,
    tilesPerIteration: cljs.types.uint_t,
    edgeTags: null,
    inputPositions: null,
    outputPositions: null,
    tilePointsParam: cljs.types.local_t,
    width: cljs.types.float_t,
    height: cljs.types.float_t,
    charge: cljs.types.float_t,
    gravity: cljs.types.float_t,
    randValues: null,
    stepNumber: cljs.types.uint_t,
    springs: null,
    workList: null,
    inputPoints: null,
    outputPoints: null,
    edgeStrength0: cljs.types.float_t,
    edgeDistance0: cljs.types.float_t,
    edgeStrength1: cljs.types.float_t,
    edgeDistance1: cljs.types.float_t,
    springPositions: null
};
Object.seal(argsType);

var GaussSeidel = function(clContext) {

    var argsPoints = ['numPoints', 'tilesPerIteration', 'inputPositions', 'outputPositions',
        'tilePointsParam', 'width', 'height', 'charge', 'gravity', 'randValues',
        'stepNumber'];

    var argsSprings = ['tilesPerIteration', 'springs', 'workList', 'edgeTags',
                      'inputPoints', 'outputPoints', 'edgeStrength0', 'edgeDistance0', 'edgeStrength1', 'edgeDistance1', 'stepNumber'];

    var argsSpringsGather = ['springs', 'workList', 'inputPoints', 'springPositions'];

    debug('Creating GaussSeidel kernels');
    this.gsPoints = new Kernel('gaussSeidelPoints', argsPoints, argsType,
                            'gaussSeidel.cl', clContext);

    this.gsSprings = new Kernel('gaussSeidelSprings', argsSprings, argsType,
                        'gaussSeidel.cl', clContext);

    this.gsSpringsGather = new Kernel('gaussSeidelSpringsGather', argsSpringsGather, argsType,
                                'gaussSeidel.cl', clContext);
};


GaussSeidel.prototype.setPhysics = function(cfg) {
    [
        [ this.gsPoints, ['charge', 'gravity'] ],
        [ this.gsSprings, ['edgeDistance0', 'edgeStrength0', 'edgeDistance1', 'edgeStrength1'] ]
    ].forEach(function (kernelPair) {
        kernelPair[1].forEach(function (arg) {
            if (arg in cfg) {
                var args = {}
                args[arg] = [cfg[arg]];
                kernelPair[0].set(args);
            }
        });
    });
}


GaussSeidel.prototype.setPoints = function(simulator) {
    var localPosSize =
        Math.min(simulator.cl.maxThreads, simulator.numPoints)
        * simulator.elementsPerPoint
        * Float32Array.BYTES_PER_ELEMENT;

    this.gsPoints.set({
        numPoints: [simulator.numPoints],
        tilesPerIteration: [simulator.tilesPerIteration],
        inputPositions: simulator.buffers.curPoints.buffer,
        outputPositions: simulator.buffers.nextPoints.buffer,
        tilePointsParam: [1],
        width: [simulator.dimensions[0]],
        height: [simulator.dimensions[1]],
        randValues: simulator.buffers.randValues.buffer,
        stepNumber: [0],
    });
}


GaussSeidel.prototype.setEdges = function(simulator) {
    this.gsSprings.set({
        tilesPerIteration: [simulator.tilesPerIteration]
    });
    this.gsSpringsGather.set({
        springs: simulator.buffers.forwardsEdges.buffer,
        workList: simulator.buffers.forwardsWorkItems.buffer,
        inputPoints: simulator.buffers.curPoints.buffer,
        springPositions: simulator.buffers.springsPos.buffer,
    });
}

function pointKernel(simulator, gsPoints, stepNumber) {
    var resources = [simulator.buffers.curPoints, simulator.buffers.nextPoints,
                     simulator.buffers.randValues];

    gsPoints.set({stepNumber: [stepNumber]});

    simulator.tickBuffers(['nextPoints', 'curPoints']);

    debug("Running gaussSeidelPoints");
    return gsPoints.exec([simulator.numPoints], resources)
        .then(function () {
            return simulator.buffers.nextPoints.copyInto(simulator.buffers.curPoints);
        }).fail(function (err) {
            console.error("ERROR Kernel gaussSeidelPoints failed ", (err||{}).stack)
        });
}


function edgeKernelSeq(simulator, gsSprings, stepNumber, edges, workItems,
                       numWorkItems, fromPoints, toPoints, edgeTags) {
    debug('edgeKernelSeq');

    var resources = [edges, workItems, fromPoints, toPoints, simulator.buffers.springsPos];

    gsSprings.set({
        springs: edges.buffer,
        workList: workItems.buffer,
        inputPoints: fromPoints.buffer,
        outputPoints: toPoints.buffer,
        stepNumber: [stepNumber],
        edgeTags: edgeTags.buffer,
    });

    simulator.tickBuffers(
        _.keys(simulator.buffers).filter(function (name) {
            return simulator.buffers[name] == toPoints;
        }));

    debug('Running gaussSeidelSprings');
    return gsSprings.exec([numWorkItems], resources);
}


function gatherKernel(simulator, gsSpringsGather) {
    var resources = [
        simulator.buffers.forwardsEdges, simulator.buffers.forwardsWorkItems,
        simulator.buffers.curPoints, simulator.buffers.springsPos
    ];

    simulator.tickBuffers(['springsPos']);

    gsSpringsGather.set({
        springs: simulator.buffers.forwardsEdges.buffer,
        workList: simulator.buffers.forwardsWorkItems.buffer,
        inputPoints: simulator.buffers.curPoints.buffer,
        springPositions: simulator.buffers.springsPos.buffer,
    });


    debug("Running gaussSeidelSpringsGather");
    return gsSpringsGather.exec([simulator.numForwardsWorkItems], resources);
}


GaussSeidel.prototype.tick = function(simulator, stepNumber) {
    var that = this;
    return Q().then(function () {
        if (simulator.locked.lockPoints) {
            debug("Points are locked, nothing to do.")
            return;
        } else {
            return pointKernel(simulator, that.gsPoints, stepNumber);
        }
    }).then(function() {
        if (simulator.numEdges <= 0 || simulator.locked.lockEdges) {
            debug("Edges are locked, nothing to do.")
            return simulator;
        }
        return edgeKernelSeq(
                simulator, that.gsSprings, stepNumber,
                simulator.buffers.forwardsEdges, simulator.buffers.forwardsWorkItems, simulator.numForwardsWorkItems,
                simulator.buffers.curPoints, simulator.buffers.nextPoints, simulator.buffers.edgeTags)
            .then(function () {
                    return edgeKernelSeq(
                    simulator, that.gsSprings, stepNumber,
                    simulator.buffers.backwardsEdges, simulator.buffers.backwardsWorkItems, simulator.numBackwardsWorkItems,
                    simulator.buffers.nextPoints, simulator.buffers.curPoints, simulator.buffers.edgeTags_reverse);
            }).fail(function (err) {
                console.error("ERROR edgeKernelSeq failed ", (err||{}).stack)
            });
    }).then(function() {
        if ((!simulator.locked.lockPoints || !simulator.locked.lockEdges)
            && simulator.numEdges > 0) {
            return gatherKernel(simulator, that.gsSpringsGather)
        }
    }).then(function () {
        return simulator;
    }).fail(function (err) {
        console.error("ERROR GaussSeidel tick failed ", (err||{}).stack)
    });
}

module.exports = GaussSeidel;
