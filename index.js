"use strict";

var API = require('cb-blockr')
var discover = require('bip32-utils').discovery
var bitcoin = require('bitcoinjs-lib')
var async = require('async')
var TxGraph = require('bitcoin-tx-graph')

function Wallet(externalAccount, internalAccount, networkName, done) {
  if(arguments.length === 0) {
    return this
  }

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

  var functions = [this.externalAccount, this.internalAccount].map(function(account) {
    return discoverFn(account, that.api)
  })

  async.parallel(functions, function(err, results) {
    if(err) return done(err);

    that.balance = results[0].balance + results[1].balance

    var receiveAddresses = results[0].addresses
    that.addressIndex = receiveAddresses.length

    var changeAddresses = results[1].addresses
    that.changeAddressIndex = changeAddresses.length

    fetchTransactions(that.api, receiveAddresses.concat(changeAddresses), function(err, txs, metadata) {
      if(err) return done(err);

      addTransactionsToGraph(txs, that.txGraph)

      that.txMetadata = metadata
      that.txGraph.calculateFeesAndValues(addresses, bitcoin.networks[that.networkName])

      done(null, that)
    })
  })
}

Wallet.prototype.getUsedAddresses = function() {
  return deriveAddresses(this.externalAccount, this.addressIndex)
}

Wallet.prototype.getUsedChangeAddresses = function() {
  return deriveAddresses(this.internalAccount, this.changeAddressIndex)
}

function deriveAddresses(account, untilId) {
  var addresses = []
  for(var i=0; i<untilId; i++) {
    addresses.push(account.derive(i).getAddress().toString())
  }
  return addresses
}

Wallet.prototype.getTransactionHistory = function() {
  var txGraph = this.txGraph

  var metadata = this.txMetadata
  var nodes = txGraph.getAllNodes().filter(function(n) {
    return n.tx != null && n.tx.value != null
  }).sort(function(a, b) {
    var confDiff = metadata[a.id].confirmations - metadata[b.id].confirmations
    if(confDiff !== 0) {
      return confDiff
    }

    return txGraph.compareNodes(a, b)
  })

  nodes.forEach(function(n) {
    if(n.tx.value < 0) {
      n.tx.value += n.tx.fee
    }
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
    addressIndex: this.addressIndex,
    changeAddressIndex: this.changeAddressIndex,
    balance: this.balance,
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
  wallet.addressIndex = deserialized.addressIndex
  wallet.changeAddressIndex = deserialized.changeAddressIndex
  wallet.balance = deserialized.balance
  wallet.networkName = deserialized.networkName
  wallet.txMetadata = deserialized.txMetadata

  wallet.txGraph = new TxGraph()
  var txs = deserialized.txs.map(function(hex) {
    return bitcoin.Transaction.fromHex(hex)
  })

  addTransactionsToGraph(txs, wallet.txGraph)

  return wallet
}

function fetchTransactions(api, addresses, done) {
  api.addresses.transactions(addresses, null, function(err, transactions) {
    if(err) return done(err);

    var txsAndConfs = parseTransactions(transactions)

    api.transactions.get(getAdditionalTxIds(txsAndConfs.txs), function(err, transactions) {
      if(err) return done(err);

      var additionalTxsAndMeta = parseTransactions(transactions)

      var txs = txsAndConfs.txs.concat(additionalTxsAndMeta.txs)
      var confirmations = txsAndConfs.confirmations.concat(additionalTxsAndMeta.confirmations)

      if(txs.length !== confirmations.length) {
        return done(new Error("expect confirmations fetched for every transaction"))
      }

      var metadata = txs.reduce(function(memo, tx, i) {
        memo[tx.getId()] = { confirmations: confirmations[i] }
        return memo
      }, {})

      done(null, txs, metadata)
    })
  })
}


function getAdditionalTxIds(txs) {
  var inputTxIds = txs.reduce(function(memo, tx) {
    tx.ins.forEach(function(input) {
      var hash = new Buffer(input.hash)
      Array.prototype.reverse.call(hash)
      memo[hash.toString('hex')] = true
    })
    return memo
  }, {})

  var txIds = txs.map(function(tx) { return tx.getId() })

  return Object.keys(inputTxIds).filter(function(id) {
    return txIds.indexOf(id) < 0
  })
}

function discoverFn(account, api) {
  return function(callback) { discoverUsedAddresses(account, api, callback) }
}

function parseTransactions(transactions) {
  return transactions.reduce(function(memo, t) {
    memo.txs.push(bitcoin.Transaction.fromHex(t.hex))
    memo.confirmations.push(t.confirmations)

    return memo
  }, {txs: [], confirmations: []})
}

function addTransactionsToGraph(transactions, graph) {
  transactions.forEach(function(tx) { graph.addTx(tx) })
}

function discoverUsedAddresses(account, api, done) {
  var usedAddresses = []
  var balance = 0

  discover(account, 5, function(addresses, callback) {

    usedAddresses = usedAddresses.concat(addresses)

    api.addresses.get(addresses, function(err, results) {
      if (err) return callback(err);

      var areSpent = results.map(function(result) {
        return result.totalReceived > 0
      })

      balance = results.reduce(function(memo, result) {
        return memo + result.balance
      }, balance)

      callback(undefined, areSpent)
    })
  }, function(err, k) {
    if (err) return done(err);

    console.info('Discovered ' + k + ' addresses')

    var data = {
      addresses: usedAddresses.slice(0, k),
      balance: balance
    }
    done(null, data)
  })
}

module.exports = Wallet

