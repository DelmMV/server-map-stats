const express = require('express');
const { MongoClient } = require('mongodb');
const haversine = require('haversine-distance');

const app = express();
const port = 5001;
const url = 'mongodb://192.168.0.107:27017';
const dbName = 'geolocation_db';

let db;

async function connectToMongoDB() {
	const client = new MongoClient(url, { useNewUrlParser: true, useUnifiedTopology: true });
	try {
		await client.connect();
		console.log('Connected successfully to MongoDB');
		db = client.db(dbName);
		
		app.listen(port, () => {
			console.log(`Server running on http://localhost:${port}`);
		});
	} catch (err) {
		console.error('Failed to connect to MongoDB:', err);
		process.exit(1); // Завершаем процесс, если подключение не удалось
	}
}

app.get('/api/route/:userId', async (req, res) => {
	const { userId } = req.params;
	const { startDate, endDate } = req.query;
	
	try {
		// Преобразуем userId в числовой формат
		const numericUserId = parseInt(userId, 10);
		if (isNaN(numericUserId)) {
			return res.status(400).json({ error: 'Неверный UserId' });
		}
		
		const query = { userId: numericUserId };
		
		if (startDate && endDate) {
			const startTimestamp = new Date(startDate).setHours(0, 0, 0, 0) / 1000;
			let endTimestamp = new Date(endDate).setHours(23, 59, 59, 999) / 1000;
			
			if (isNaN(startTimestamp) || isNaN(endTimestamp)) {
				return res.status(400).json({ error: 'Неверный формат' });
			}
			
			if (startTimestamp > endTimestamp) {
				return res.status(400).json({ error: 'Дата начала должна быть раньше или равна дате окончания' });
			}
			
			query.timestamp = {
				$gte: startTimestamp,
				$lte: endTimestamp,
			};
		}
		
		const userRoute = await db.collection('locations').find(query).sort({ timestamp: 1 }).toArray();
		
		if (userRoute.length === 0) {
			return res.status(404).json({ error: 'Маршруты не найдены' });
		}
		
		res.json(userRoute);
	} catch (error) {
		console.error('Error fetching user route:', error);
		res.status(500).json({ error: 'Что-то пошло не так' });
	}
});

// Функция для расчета статистики
const calculateStats = async (userId, startTimestamp, endTimestamp) => {
	const collection = db.collection('locations');
	
	const locations = await collection.find({
		userId,
		timestamp: { $gte: startTimestamp, $lte: endTimestamp }
	}).sort({ sessionId: 1, timestamp: 1 }).toArray();
	
	if (locations.length < 2) return { distance: 0, speed: 0, dailyStats: [] };
	
	let totalDistance = 0;
	let totalTime = 0;
	let lastSessionId = locations[0].sessionId;
	let dailyStats = Array(7).fill().map(() => ({ distance: 0, time: 0 }));
	
	for (let i = 1; i < locations.length; i++) {
		const prev = locations[i - 1];
		const curr = locations[i];
		
		if (curr.sessionId !== lastSessionId) {
			lastSessionId = curr.sessionId;
			continue;
		}
		
		const dist = haversine(
				{ lat: prev.latitude, lon: prev.longitude },
				{ lat: curr.latitude, lon: curr.longitude }
		);
		const timeDiff = curr.timestamp - prev.timestamp;
		
		totalDistance += dist;
		
		if (timeDiff < 3600) {
			totalTime += timeDiff;
		}
		
		const dayIndex = new Date(curr.timestamp * 1000).getDay();
		const adjustedIndex = (dayIndex + 6) % 7;
		dailyStats[adjustedIndex].distance += dist;
		dailyStats[adjustedIndex].time += timeDiff;
	}
	
	const avgSpeed = totalTime > 0 ? (totalDistance / 1000) / (totalTime / 3600) : 0;
	
	dailyStats = dailyStats.map(day => ({
		distance: day.distance / 1000,
		speed: day.time > 0 ? (day.distance / 1000) / (day.time / 3600) : 0
	}));
	
	return { distance: totalDistance / 1000, speed: avgSpeed, dailyStats };
};

// Функция для получения топ пользователей
const getTopUsers = async (period, limit) => {
	const collection = db.collection('locations');
	const now = new Date();
	let startTimestamp, endTimestamp;
	
	if (period === 'week') {
		const dayOfWeek = now.getDay();
		const monday = new Date(now);
		monday.setHours(0, 0, 0, 0);
		monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
		const sunday = new Date(monday);
		sunday.setDate(monday.getDate() + 6);
		sunday.setHours(23, 59, 59, 999);
		
		startTimestamp = Math.floor(monday.getTime() / 1000);
		endTimestamp = Math.floor(sunday.getTime() / 1000);
	} else if (period === 'month') {
		const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
		const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
		lastDayOfMonth.setHours(23, 59, 59, 999);
		
		startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
		endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
	} else {
		throw new Error('Invalid period');
	}
	
	const uniqueUsers = await collection.aggregate([
		{ $match: { timestamp: { $gte: startTimestamp, $lte: endTimestamp } } },
		{ $group: { _id: "$userId", username: { $first: "$username" } } }
	]).toArray();
	
	const userDistances = [];
	for (const user of uniqueUsers) {
		const stats = await calculateStats(user._id, startTimestamp, endTimestamp);
		userDistances.push({
			userId: user._id,
			username: user.username,
			distance: stats.distance
		});
	}
	
	userDistances.sort((a, b) => b.distance - a.distance);
	return userDistances.slice(0, limit);
};

const calculateWeeklyStats = async (userId) => {
	const now = new Date();
	const dayOfWeek = now.getDay();
	const monday = new Date(now);
	monday.setHours(0, 0, 0, 0);
	monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
	const sunday = new Date(monday);
	sunday.setDate(monday.getDate() + 6);
	sunday.setHours(23, 59, 59, 999);
	
	const startTimestamp = Math.floor(monday.getTime() / 1000);
	const endTimestamp = Math.floor(sunday.getTime() / 1000);
	
	const stats = await calculateStats(userId, startTimestamp, endTimestamp);
	
	const daysOfWeek = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
	
	const detailedStats = {
		totalDistance: stats.distance,
		averageSpeed: stats.speed,
		dailyStats: stats.dailyStats.map((day, index) => ({
			day: daysOfWeek[index],
			distance: day.distance,
			averageSpeed: day.speed
		}))
	};
	
	return detailedStats;
};

// Новый эндпоинт для получения топ-10 пользователей за неделю
app.get('/api/top-users/week', async (req, res) => {
	try {
		const topUsers = await getTopUsers('week', 10);
		res.json(topUsers);
	} catch (error) {
		console.error('Error fetching top users for the week:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Новый эндпоинт для получения топ-10 пользователей за месяц
app.get('/api/top-users/month', async (req, res) => {
	try {
		const topUsers = await getTopUsers('month', 10);
		res.json(topUsers);
	} catch (error) {
		console.error('Error fetching top users for the month:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/api/user-stats/week/:userId', async (req, res) => {
	try {
		const userId = parseInt(req.params.userId, 10);
		if (isNaN(userId)) {
			return res.status(400).json({ error: 'Invalid userId' });
		}
		
		const stats = await calculateWeeklyStats(userId);
		res.json(stats);
	} catch (error) {
		console.error('Error fetching weekly stats for user:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

connectToMongoDB();

