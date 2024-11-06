const { BluefinClient } = require('@bluefin-exchange/bluefin-v2-client');
const { Wallet } = require('ethers');

class GridTradingBot {
    constructor(config) {
        const wallet = new Wallet(config.privateKey);
        this.client = new BluefinClient({
            wallet: wallet,
            testnet: config.testnet
        });
        
        this.symbol = config.symbol;
        this.gridSize = config.gridSize;
        this.upperPrice = config.upperPrice;
        this.lowerPrice = config.lowerPrice;
        this.quantity = config.quantity;
        this.leverage = config.leverage;
        this.takeProfitPrice = config.takeProfitPrice;
        this.stopLossPrice = config.stopLossPrice;
        
        this.stats = {
            totalPnL: 0,
            profitTrades: 0,
            lossTrades: 0,
            totalTrades: 0
        };
        
        this.gridLevels = [];
        this.activeOrders = new Map();
    }

    async initialize() {
        await this.client.connect();
        await this.setLeverage(this.leverage);
        this.calculateGridLevels();
        await this.placeInitialOrders();
    }

    async setLeverage(leverage) {
        try {
            await this.client.setLeverage({
                symbol: this.symbol,
                leverage: leverage
            });
            console.log(`Leverage set to ${leverage}x`);
        } catch (error) {
            console.error('Error setting leverage:', error);
        }
    }

    async getLeverage() {
        try {
            const position = await this.client.getPosition(this.symbol);
            return position.leverage;
        } catch (error) {
            console.error('Error getting leverage:', error);
            return null;
        }
    }

    calculateGridLevels() {
        const priceDiff = this.upperPrice - this.lowerPrice;
        const interval = priceDiff / (this.gridSize - 1);
        
        for (let i = 0; i < this.gridSize; i++) {
            this.gridLevels.push(this.lowerPrice + (interval * i));
        }
    }

    async placeInitialOrders() {
        const currentPrice = await this.getCurrentPrice();
        
        for (const level of this.gridLevels) {
            if (level < currentPrice) {
                await this.placeBuyOrder(level);
            } else {
                await this.placeSellOrder(level);
            }
        }
    }

    async placeBuyOrder(price) {
        try {
            const order = await this.client.createOrder({
                symbol: this.symbol,
                side: 'BUY',
                type: 'LIMIT',
                quantity: this.quantity,
                price: price,
                timeInForce: 'GTC'
            });
            
            this.activeOrders.set(order.orderId, {
                price,
                side: 'BUY',
                takeProfitPrice: this.takeProfitPrice,
                stopLossPrice: this.stopLossPrice
            });
            
            return order;
        } catch (error) {
            console.error('Error placing buy order:', error);
        }
    }

    async placeSellOrder(price) {
        try {
            const order = await this.client.createOrder({
                symbol: this.symbol,
                side: 'SELL',
                type: 'LIMIT',
                quantity: this.quantity,
                price: price,
                timeInForce: 'GTC'
            });
            
            this.activeOrders.set(order.orderId, {
                price,
                side: 'SELL',
                takeProfitPrice: this.takeProfitPrice,
                stopLossPrice: this.stopLossPrice
            });
            
            return order;
        } catch (error) {
            console.error('Error placing sell order:', error);
        }
    }

    async handleOrderFill(orderId, fillPrice) {
        const order = this.activeOrders.get(orderId);
        if (!order) return;

        // Place opposite order for grid continuation
        if (order.side === 'BUY') {
            await this.placeSellOrder(order.price * (1 + this.gridSize));
        } else {
            await this.placeBuyOrder(order.price * (1 - this.gridSize));
        }

        // Monitor for take-profit and stop-loss
        this.monitorPosition(orderId, fillPrice, order);
    }

    async monitorPosition(orderId, entryPrice, order) {
        const checkPrice = async () => {
            const currentPrice = await this.getCurrentPrice();
            
            if (order.side === 'BUY') {
                if (currentPrice >= this.takeProfitPrice) {
                    await this.closePosition(orderId, currentPrice, 'PROFIT');
                } else if (currentPrice <= this.stopLossPrice) {
                    await this.closePosition(orderId, currentPrice, 'LOSS');
                }
            } else {
                if (currentPrice <= this.takeProfitPrice) {
                    await this.closePosition(orderId, currentPrice, 'PROFIT');
                } else if (currentPrice >= this.stopLossPrice) {
                    await this.closePosition(orderId, currentPrice, 'LOSS');
                }
            }
        };

        // Check price every 5 seconds
        const intervalId = setInterval(checkPrice, 5000);
        this.activeOrders.get(orderId).intervalId = intervalId;
    }

    async closePosition(orderId, currentPrice, type) {
        const order = this.activeOrders.get(orderId);
        if (!order) return;

        clearInterval(order.intervalId);
        
        const pnl = order.side === 'BUY' 
            ? (currentPrice - order.price) * this.quantity
            : (order.price - currentPrice) * this.quantity;

        // Update statistics
        this.stats.totalPnL += pnl;
        this.stats.totalTrades++;
        if (type === 'PROFIT') {
            this.stats.profitTrades++;
        } else {
            this.stats.lossTrades++;
        }

        // Close position
        await this.client.createOrder({
            symbol: this.symbol,
            side: order.side === 'BUY' ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: this.quantity
        });

        this.activeOrders.delete(orderId);
        this.logStats();
    }

    async getCurrentPrice() {
        const ticker = await this.client.getTicker(this.symbol);
        return parseFloat(ticker.lastPrice);
    }

    logStats() {
        console.log('=== Trading Statistics ===');
        console.log(`Current Leverage: ${this.leverage}x`);
        console.log(`Total P&L: ${this.stats.totalPnL.toFixed(4)}`);
        console.log(`Total Trades: ${this.stats.totalTrades}`);
        console.log(`Profitable Trades: ${this.stats.profitTrades}`);
        console.log(`Loss Trades: ${this.stats.lossTrades}`);
        console.log(`Win Rate: ${(this.stats.profitTrades / this.stats.totalTrades * 100).toFixed(2)}%`);
        console.log('=====================');
    }
}

const config = require('./config');
const bot = new GridTradingBot(config);
bot.initialize().catch(console.error);