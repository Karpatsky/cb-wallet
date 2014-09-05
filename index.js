"use strict";

var API = require('cb-blockr')
var bitcoin = require('bitcoinjs-lib')
var TxGraph = require('bitcoin-tx-graph')
var discoverAddresses = require('./network').discoverAddresses
var fetchTransactions = require('./network').fetchTransactions

function Wallet(externalAccount, internalAccount, networkName, done) {
  if(arguments.length === 0) return this;

  try {
    this.externalAccount = bitcoin.HDNode.fromBase58(externalAccount)
    this.internalAccount = bitcoin.HDNode.fromBase58(internalAccount)
  } catch(e) {
    return done(e)
  }

  this.networkName = networkName
  this.api = new API(networkName)
  this.txGraph = new TxGraph()

  var that = this

  discoverAddresses(this.api, this.externalAccount, this.internalAccount, function(err, addresses, changeAddresses) {
    if(err) return done(err);

    that.addresses = addresses
    that.changeAddresses = changeAddresses

    var addresses = addresses.concat(changeAddresses)
    fetchTransactions(that.api, addresses, function(err, txs, metadata) {
      if(err) return done(err);

      txs.forEach(function(tx) { that.txGraph.addTx(tx) })

      var feesAndValues = that.txGraph.calculateFeesAndValues(addresses, bitcoin.networks[that.networkName])
      that.txMetadata = mergeMetadata(feesAndValues, metadata)

      done(null, that)
    })
  })
}

Wallet.prototype.getBalance = function() {
  var metadata = this.txMetadata
  return this.txGraph.heads.reduce(function(balance, node) {
    var value = metadata[node.id].value
    if(value == null || value <= 0) return balance;

    return balance + value
  }, 0)
}

Wallet.prototype.getNextChangeAddress = function() {
  return this.internalAccount.derive(this.changeAddresses.length).getAddress().toString()
}

Wallet.prototype.getNextAddress = function() {
  return this.externalAccount.derive(this.addresses.length).getAddress().toString()
}

Wallet.prototype.processTx = function(tx, prevTx, txConf) {
  this.txGraph.addTx(tx)
  this.txGraph.addTx(prevTx)
  this.txMetadata[tx.getId()] = { confirmations: txConf }

  //FIXME: make me more effecient
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var feesAndValues = this.txGraph.calculateFeesAndValues(myAddresses, bitcoin.networks[this.networkName])
  this.txMetadata = mergeMetadata(feesAndValues, this.txMetadata)
}

Wallet.prototype.createTx = function(to, value, fee) {
  var network = bitcoin.networks[this.networkName]
  var myAddresses = this.addresses.concat(this.changeAddresses)
  var utxos = getCandidateOutputs(this.txGraph.heads, this.txMetadata, network, myAddresses)

  var accum = 0
  var subTotal = value
  var addresses = []

  var tx = new bitcoin.Transaction()
  tx.addOutput(to, value)

  var that = this
  utxos.some(function(unspent) {
    tx.addInput(unspent.id, unspent.index)
    addresses.push(unspent.address)

    var estimatedFee
    if(fee == undefined) {
      estimatedFee = estimateFeePadChangeOutput(tx, network)
    } else {
      estimatedFee = fee
    }

    accum += unspent.value
    subTotal = value + estimatedFee
    if (accum >= subTotal) {
      var change = accum - subTotal

      if (change > network.dustThreshold) {
        tx.addOutput(that.getNextChangeAddress(), change)
      }

      return true
    }
  })

  return tx
}

function getCandidateOutputs(headNodes, metadata, network, myAddresses) {
  var unspentNodes = headNodes.filter(function(n) {
    var value = metadata[n.id].value
    return value > 0
  })

  var unspentOutputs = unspentNodes.reduce(function(unspentOutputs, node) {
    node.tx.outs.forEach(function(out, i) {
      var address = bitcoin.Address.fromOutputScript(out.script, network).toString()
      if(myAddresses.indexOf(address) >= 0) {
        unspentOutputs.push({
          id: node.id,
          address: address,
          value: out.value,
          index: i
        })
      }
    })

    return unspentOutputs
  }, [])


  return unspentOutputs.sort(function(o1, o2){
    return o2.value - o1.value
  })
}

function estimateFeePadChangeOutput(tx, network) {
  var tmpTx = tx.clone()
  var tmpAddress = bitcoin.Address.fromOutputScript(tx.outs[0].script, network)
  tmpTx.addOutput(tmpAddress, network.dustSoftThreshold || 0)

  return network.estimateFee(tmpTx)
}

Wallet.prototype.getTransactionHistory = function() {
  var txGraph = this.txGraph
  var metadata = this.txMetadata

  var nodes = txGraph.getAllNodes().filter(function(n) {
    return n.tx != null && metadata[n.id].value != null
  }).sort(function(a, b) {
    var confDiff = metadata[a.id].confirmations - metadata[b.id].confirmations
    if(confDiff !== 0) {
      return confDiff
    }

    return txGraph.compareNodes(a, b)
  })

  return nodes.map(function(n) {
    return n.tx
  })
}

Wallet.prototype.serialize = function() {
  var txs = this.txGraph.getAllNodes().reduce(function(memo, node) {
    var tx = node.tx
    if(tx == null) return memo;

    memo.push(tx.toHex())
    return memo
  }, [])

  return JSON.stringify({
    externalAccount: this.externalAccount.toBase58(),
    internalAccount: this.internalAccount.toBase58(),
    addressIndex: this.addresses.length,
    changeAddressIndex: this.changeAddresses.length,
    networkName: this.networkName,
    txs: txs,
    txMetadata: this.txMetadata
  })
}

Wallet.deserialize = function(json) {
  var wallet = new Wallet()
  var deserialized = JSON.parse(json)
  wallet.externalAccount = bitcoin.HDNode.fromBase58(deserialized.externalAccount)
  wallet.internalAccount = bitcoin.HDNode.fromBase58(deserialized.internalAccount)
  wallet.addresses = deriveAddresses(wallet.externalAccount, deserialized.addressIndex)
  wallet.changeAddresses = deriveAddresses(wallet.internalAccount, deserialized.changeAddressIndex)
  wallet.networkName = deserialized.networkName
  wallet.txMetadata = deserialized.txMetadata

  wallet.txGraph = new TxGraph()
  deserialized.txs.forEach(function(hex) {
    wallet.txGraph.addTx(bitcoin.Transaction.fromHex(hex))
  })

  return wallet
}


function mergeMetadata(feesAndValues, metadata) {
  for(var id in metadata) {
    var fee = feesAndValues[id].fee
    if(fee != null) metadata[id].fee = fee

    var value = feesAndValues[id].value
    if(value < 0) value += fee
    if(value != null) metadata[id].value = value
  }

  return metadata
}

function deriveAddresses(account, untilId) {
  var addresses = []
  for(var i=0; i<untilId; i++) {
    addresses.push(account.derive(i).getAddress().toString())
  }
  return addresses
}

module.exports = Wallet

