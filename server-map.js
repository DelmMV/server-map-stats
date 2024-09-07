const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const haversine = require('haversine-distance');
const multer = require('multer');
const path = require('path');
const cors = require('cors')
require('dotenv').config()

const app = express();
const port = 5001;
const url = 'mongodb://192.168.0.107:27017';
const dbName = 'geolocation_db';
const centerLat = 59.9505;

let db;

async function connectToMongoDB() {
	const client = new MongoClient(url);
	try {
		await client.connect();
		console.log('Connected successfully to MongoDB');
		db = client.db(dbName);
		scheduleMonthlyHeatmapUpdates();
		app.listen(port, () => {
			console.log(`Server running on http://localhost:${port}`);
		});
	} catch (err) {
		console.error('Failed to connect to MongoDB:', err);
		process.exit(1); // Завершаем процесс, если подключение не удалось
	}
}
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use(cors());

// Настройка multer для загрузки фотографий
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });
const apiBaseUrl = process.env.API_BASE_URL || 'https://monopiter.ru';

// Получение списка зарядных станций
app.get('/api/charging-stations', async (req, res) => {
  try {
    const stations = await db.collection('charging_stations').find().toArray();
    res.json(stations);
  } catch (error) {
    console.error('Error fetching charging stations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// Добавление новой зарядной станции
app.post('/api/charging-stations', upload.single('photo'), async (req, res) => {
  try {
    const { latitude, longitude, comment, userId, addedBy, addedAt } = req.body;
    const photo = req.file ? `${apiBaseUrl}/uploads/${req.file.filename}` : null;

    const station = {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      comment,
      photo,
      userId: parseInt(userId),
      addedBy: JSON.parse(addedBy),
      addedAt: new Date(addedAt),
    };

    const result = await db.collection('charging_stations').insertOne(station);
    res.status(201).json({ ...station, _id: result.insertedId });
  } catch (error) {
    console.error('Error adding charging station:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Обновление зарядной станции
app.put('/api/charging-stations/:id', upload.single('photo'), async (req, res) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, comment } = req.body;
    const updateData = {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      comment
    };

    if (req.file) {
      updateData.photo = `${apiBaseUrl}/uploads/${req.file.filename}`;
    }

    const result = await db.collection('charging_stations').updateOne(
      { _id: new ObjectId(id) },  // Используем new ObjectId(id) здесь
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Charging station not found' });
    }

    res.json({ message: 'Charging station updated successfully' });
  } catch (error) {
    console.error('Error updating charging station:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Удаление зарядной станции
app.delete('/api/charging-stations/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.collection('charging_stations').deleteOne({ _id: new ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Charging station not found' });
    }

    res.json({ message: 'Charging station deleted successfully' });
  } catch (error) {
    console.error('Error deleting charging station:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const updateMonthlyHeatmap = async (year, month) => {
    const collection = db.collection('locations');
    const heatmapCollection = db.collection('monthly_heatmaps');

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    const startTimestamp = Math.floor(startDate.getTime() / 1000);
    const endTimestamp = Math.floor(endDate.getTime() / 1000);

    const query = {
        timestamp: {
            $gte: startTimestamp,
            $lte: endTimestamp
        }
    };

    const data = await collection.find(query).toArray();

    const heatmapData = data.reduce((acc, loc) => {
        const key = `${loc.latitude.toFixed(3)},${loc.longitude.toFixed(3)}`;
        if (!acc[key]) {
            acc[key] = { latitude: loc.latitude, longitude: loc.longitude, intensity: 0 };
        }
        acc[key].intensity += 1;
        return acc;
    }, {});

    const result = Object.values(heatmapData);

    await heatmapCollection.updateOne(
        { year, month },
        { $set: { heatmapData: result } },
        { upsert: true }
    );

    console.log(`Updated heatmap data for ${year}-${month}`);
};

const scheduleMonthlyHeatmapUpdates = () => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    // Обновляем данные за текущий и предыдущий месяц
    updateMonthlyHeatmap(currentYear, currentMonth);
    updateMonthlyHeatmap(currentYear, currentMonth - 1);

    // Планируем следующее обновление через день
    setTimeout(scheduleMonthlyHeatmapUpdates, 24 * 60 * 60 * 1000);
};

app.get('/api/monthly-heatmap/:year/:month', async (req, res) => {
    try {
        const year = parseInt(req.params.year);
        const month = parseInt(req.params.month);

        if (isNaN(year) || isNaN(month) || month < 1 || month > 12) {
            return res.status(400).json({ error: 'Invalid year or month' });
        }

        const heatmapCollection = db.collection('monthly_heatmaps');
        const result = await heatmapCollection.findOne({ year, month });

        if (!result) {
            return res.status(404).json({ error: 'Heatmap data not found for the specified month' });
        }

        res.json(result.heatmapData);
    } catch (error) {
        console.error('Error fetching monthly heatmap data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/yearly-heatmap/:year', async (req, res) => {
    try {
        const year = parseInt(req.params.year);

        if (isNaN(year)) {
            return res.status(400).json({ error: 'Invalid year' });
        }

        const heatmapCollection = db.collection('monthly_heatmaps');
        const results = await heatmapCollection.find({ year }).toArray();

        if (results.length === 0) {
            return res.json({ heatmapData: [], message: 'No data available for this year' });
        }

        // Объединяем данные за все месяцы
        const combinedHeatmapData = results.reduce((acc, month) => {
            month.heatmapData.forEach(point => {
                const key = `${point.latitude},${point.longitude}`;
                if (!acc[key]) {
                    acc[key] = { ...point };
                } else {
                    acc[key].intensity += point.intensity;
                }
            });
            return acc;
        }, {});

        const yearlyHeatmapData = Object.values(combinedHeatmapData);

        res.json(yearlyHeatmapData);
    } catch (error) {
        console.error('Error fetching yearly heatmap data:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/heatmap', async (req, res) => {
	try {
		let { startDate, endDate } = req.query;
		
		if (!startDate || !endDate) {
			return res.status(400).json({ error: 'Both startDate and endDate are required' });
		}
		
		const startTimestamp = Math.floor(new Date(startDate).getTime() / 1000);
		const endTimestamp = Math.floor(new Date(endDate).getTime() / 1000);
		
		const collection = db.collection('locations');
		
		const query = {
			timestamp: {
				$gte: startTimestamp,
				$lte: endTimestamp
			}
		};
		const data = await collection.find(query).toArray();
		if (data.length === 0) {
			return res.json([]);
		}
		
		// Process data for heatmap (group by location and count occurrences)
		const heatmapData = data.reduce((acc, loc) => {
			const key = `${loc.latitude},${loc.longitude}`;
			if (!acc[key]) {
				acc[key] = { latitude: loc.latitude, longitude: loc.longitude, intensity: 0 };
			}
			acc[key].intensity += 1;
			return acc;
		}, {});
		
		const result = Object.values(heatmapData);
		
		res.json(result);
	} catch (error) {
		console.error('Error fetching heatmap data:', error);
		res.status(500).json({ error: 'Internal server error', message: error.message });
	}
});


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

const getTopUsers = async (period, limit) => {
	const collection = db.collection('locations');
	const now = new Date();
	let startTimestamp, endTimestamp;
	
	switch (period) {
		case 'this_week':
		{
			const dayOfWeek = now.getDay();
			const monday = new Date(now);
			monday.setHours(0, 0, 0, 0);
			monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)); // Понедельник текущей недели
			const sunday = new Date(monday);
			sunday.setDate(monday.getDate() + 6);
			sunday.setHours(23, 59, 59, 999); // Воскресенье текущей недели
			
			startTimestamp = Math.floor(monday.getTime() / 1000);
			endTimestamp = Math.floor(sunday.getTime() / 1000);
		}
			break;
		
		case 'last_week':
		{
			const lastWeek = new Date(now);
			lastWeek.setDate(lastWeek.getDate() - 7); // Сдвиг на неделю назад
			
			const dayOfWeek = lastWeek.getDay();
			const lastMonday = new Date(lastWeek);
			lastMonday.setHours(0, 0, 0, 0);
			lastMonday.setDate(lastWeek.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)); // Понедельник прошлой недели
			const lastSunday = new Date(lastMonday);
			lastSunday.setDate(lastMonday.getDate() + 6);
			lastSunday.setHours(23, 59, 59, 999); // Воскресенье прошлой недели
			
			startTimestamp = Math.floor(lastMonday.getTime() / 1000);
			endTimestamp = Math.floor(lastSunday.getTime() / 1000);
		}
			break;
		
		case 'this_month':
		{
			const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
			const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
			lastDayOfMonth.setHours(23, 59, 59, 999); // Последний день текущего месяца
			
			startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
			endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
		}
			break;
		
		case 'last_month':
		{
			const firstDayOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
			lastDayOfLastMonth.setHours(23, 59, 59, 999); // Последний день прошлого месяца
			
			startTimestamp = Math.floor(firstDayOfLastMonth.getTime() / 1000);
			endTimestamp = Math.floor(lastDayOfLastMonth.getTime() / 1000);
		}
			break;
		
		default:
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
			distance: stats.distance,
			averageSpeed: stats.speed
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

app.get('/api/top-users/this_week', async (req, res) => {
	try {
		const topUsers = await getTopUsers('this_week', 50);
		res.json(topUsers);
	} catch (error) {
		console.error('Error fetching top users for the week:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/api/top-users/last_week', async (req, res) => {
	try {
		const topUsers = await getTopUsers('last_week', 50);
		res.json(topUsers);
	} catch (error) {
		console.error('Error fetching top users for the week:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/api/top-users/this_month', async (req, res) => {
	try {
		const topUsers = await getTopUsers('this_month', 50);
		res.json(topUsers);
	} catch (error) {
		console.error('Error fetching top users for the month:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/api/top-users/last_month', async (req, res) => {
	try {
		const topUsers = await getTopUsers('last_month', 100);
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

const calculateTotalDistance = async (period) => {
	const collection = db.collection('locations');
	const now = new Date();
	let startTimestamp, endTimestamp;
	
	switch (period) {
		case 'this_week':
		{
			const dayOfWeek = now.getDay();
			const monday = new Date(now);
			monday.setHours(0, 0, 0, 0);
			monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
			const sunday = new Date(monday);
			sunday.setDate(monday.getDate() + 6);
			sunday.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(monday.getTime() / 1000);
			endTimestamp = Math.floor(sunday.getTime() / 1000);
		}
			break;
		
		case 'last_week':
		{
			const lastWeek = new Date(now);
			lastWeek.setDate(lastWeek.getDate() - 7);
			
			const dayOfWeek = lastWeek.getDay();
			const lastMonday = new Date(lastWeek);
			lastMonday.setHours(0, 0, 0, 0);
			lastMonday.setDate(lastWeek.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
			const lastSunday = new Date(lastMonday);
			lastSunday.setDate(lastMonday.getDate() + 6);
			lastSunday.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(lastMonday.getTime() / 1000);
			endTimestamp = Math.floor(lastSunday.getTime() / 1000);
		}
			break;
		
		case 'this_month':
		{
			const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
			const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
			lastDayOfMonth.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
			endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
		}
			break;
		
		case 'last_month':
		{
			const firstDayOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
			lastDayOfLastMonth.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(firstDayOfLastMonth.getTime() / 1000);
			endTimestamp = Math.floor(lastDayOfLastMonth.getTime() / 1000);
		}
			break;
		
		default:
			throw new Error('Invalid period');
	}
	
	const result = await collection.aggregate([
		{
			$match: {
				timestamp: { $gte: startTimestamp, $lte: endTimestamp }
			}
		},
		{
			$group: {
				_id: { userId: "$userId", sessionId: "$sessionId" },
				coordinates: {
					$push: {
						latitude: "$latitude",
						longitude: "$longitude",
						timestamp: "$timestamp"
					}
				}
			}
		}
	]).toArray();
	
	let totalDistance = 0;
	
	for (const session of result) {
		let sessionDistance = 0;
		const coordinates = session.coordinates;
		
		for (let i = 1; i < coordinates.length; i++) {
			const prev = coordinates[i - 1];
			const curr = coordinates[i];
			
			// Проверяем, что точки принадлежат одной сессии (разница во времени менее часа)
			if (curr.timestamp - prev.timestamp < 3600) {
				const distance = haversine(
						{ lat: prev.latitude, lon: prev.longitude },
						{ lat: curr.latitude, lon: curr.longitude }
				);
				sessionDistance += distance;
			}
		}
		
		totalDistance += sessionDistance;
	}
	
	return totalDistance / 1000; // Конвертируем в километры
};

app.get('/api/total-distance/:period', async (req, res) => {
	const { period } = req.params;
	
	if (!['this_week', 'last_week', 'this_month', 'last_month'].includes(period)) {
		return res.status(400).json({ error: 'Invalid period' });
	}
	
	try {
		const totalDistance = await calculateTotalDistance(period);
		res.json({ period, totalDistance });
	} catch (error) {
		console.error(`Error calculating total distance for ${period}:`, error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

const getTopLongestSessions = async (period, limit) => {
	const { startTimestamp, endTimestamp } = getPeriodTimestamps(period);
	const collection = db.collection('locations');
	
	const result = await collection.aggregate([
		{
			$match: {
				timestamp: { $gte: startTimestamp, $lte: endTimestamp }
			}
		},
		{
			$group: {
				_id: { userId: "$userId", sessionId: "$sessionId" },
				username: { $first: "$username" },
				coordinates: {
					$push: {
						latitude: "$latitude",
						longitude: "$longitude",
						timestamp: "$timestamp"
					}
				},
				firstTimestamp: { $min: "$timestamp" },
				lastTimestamp: { $max: "$timestamp" }
			}
		},
		{
			$project: {
				userId: "$_id.userId",
				username: 1,
				sessionId: "$_id.sessionId",
				coordinates: 1,
				firstTimestamp: 1,
				lastTimestamp: 1,
			}
		},
		{
			$addFields: {
				sessionDuration: { $divide: [{ $subtract: ["$lastTimestamp", "$firstTimestamp"] }, 60] } // in minutes
			}
		},
		{
			$sort: { "sessionDuration": -1 }
		},
		{
			$group: {
				_id: "$userId",
				topSession: { $first: "$$ROOT" } // Take the top session per user
			}
		},
		{
			$replaceRoot: { newRoot: "$topSession" }
		},
		{
			$sort: { "sessionDuration": -1 } // Final sorting by session duration
		},
		{
			$limit: limit
		}
	]).toArray();
	
	const topSessions = result.map(session => {
		let sessionDistance = 0;
		let sessionDuration = 0;
		const coordinates = session.coordinates;
		
		for (let i = 1; i < coordinates.length; i++) {
			const prev = coordinates[i - 1];
			const curr = coordinates[i];
			
			const timeDiff = curr.timestamp - prev.timestamp;
			if (timeDiff < 3600) {  // If the time difference is less than 1 hour, it's considered part of the session
				const distance = haversine(
						{ lat: prev.latitude, lon: prev.longitude },
						{ lat: curr.latitude, lon: curr.longitude }
				);
				sessionDistance += distance;
				sessionDuration += timeDiff;
			}
		}
		
		return {
			userId: session.userId,
			username: session.username,
			sessionId: session.sessionId,
			sessionLength: coordinates.length,
			distance: sessionDistance / 1000, // Convert to kilometers
			duration: sessionDuration / 60 // Convert to minutes
		};
	});
	
	return topSessions.sort((a, b) => b.distance - a.distance);
};



const getTopDailyDistances = async (period, limit) => {
	const { startTimestamp, endTimestamp } = getPeriodTimestamps(period);
	const collection = db.collection('locations');
	
	const result = await collection.aggregate([
		{
			$match: {
				timestamp: { $gte: startTimestamp, $lte: endTimestamp }
			}
		},
		{
			$group: {
				_id: {
					userId: "$userId",
					date: {
						$dateToString: {
							format: "%Y-%m-%d",
							date: { $toDate: { $multiply: ["$timestamp", 1000] } }
						}
					}
				},
				username: { $first: "$username" },
				coordinates: {
					$push: {
						latitude: "$latitude",
						longitude: "$longitude",
						sessionId: "$sessionId",
						timestamp: "$timestamp"
					}
				}
			}
		},
		{ $sort: { "_id.date": 1, "_id.userId": 1 } }
	]).toArray();
	
	const dailyDistances = result.map(day => {
		let dailyDistance = 0;
		let lastSessionId = null;
		let lastCoordinate = null;
		
		// Ensure the coordinates are sorted by sessionId and timestamp
		const sortedCoordinates = day.coordinates.sort((a, b) => {
			if (a.sessionId === b.sessionId) {
				return a.timestamp - b.timestamp;
			}
			return a.sessionId - b.sessionId;
		});
		
		for (let i = 0; i < sortedCoordinates.length; i++) {
			const coordinate = sortedCoordinates[i];
			
			if (lastCoordinate !== null && lastSessionId === coordinate.sessionId) {
				const distance = haversine(
						{ lat: lastCoordinate.latitude, lon: lastCoordinate.longitude },
						{ lat: coordinate.latitude, lon: coordinate.longitude }
				);
				dailyDistance += distance;
			}
			
			lastCoordinate = coordinate;
			lastSessionId = coordinate.sessionId;
		}
		
		return {
			userId: day._id.userId,
			username: day.username,
			date: day._id.date,
			distance: dailyDistance / 1000, // in kilometers
		};
	});
	
	// Group by user and keep the entry with the highest distance for each user
	const uniqueUsers = {};
	dailyDistances.forEach(entry => {
		if (!uniqueUsers[entry.userId] || uniqueUsers[entry.userId].distance < entry.distance) {
			uniqueUsers[entry.userId] = entry;
		}
	});
	
	// Convert the object back to an array and sort by distance
	const uniqueDailyDistances = Object.values(uniqueUsers);
	uniqueDailyDistances.sort((a, b) => b.distance - a.distance);
	
	// Return the top results
	return uniqueDailyDistances.slice(0, limit);
};



const getPeriodTimestamps = (period) => {
	const now = new Date();
	let startTimestamp, endTimestamp;
	
	switch (period) {
		case 'this_week':
		{
			const dayOfWeek = now.getDay();
			const monday = new Date(now);
			monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
			monday.setHours(0, 0, 0, 0);
			const sunday = new Date(monday);
			sunday.setDate(monday.getDate() + 6);
			sunday.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(monday.getTime() / 1000);
			endTimestamp = Math.floor(sunday.getTime() / 1000);
		}
			break;
		
		case 'last_week':
		{
			const dayOfWeek = now.getDay();
			const lastMonday = new Date(now);
			lastMonday.setDate(now.getDate() - (dayOfWeek === 0 ? 13 : dayOfWeek + 6));
			lastMonday.setHours(0, 0, 0, 0);
			const lastSunday = new Date(lastMonday);
			lastSunday.setDate(lastMonday.getDate() + 6);
			lastSunday.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(lastMonday.getTime() / 1000);
			endTimestamp = Math.floor(lastSunday.getTime() / 1000);
		}
			break;
		
		case 'this_month':
		{
			const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
			firstDayOfMonth.setHours(0, 0, 0, 0);
			const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
			lastDayOfMonth.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
			endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
		}
			break;
		
		case 'last_month':
		{
			const firstDayOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
			firstDayOfLastMonth.setHours(0, 0, 0, 0);
			const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
			lastDayOfLastMonth.setHours(23, 59, 59, 999);
			
			startTimestamp = Math.floor(firstDayOfLastMonth.getTime() / 1000);
			endTimestamp = Math.floor(lastDayOfLastMonth.getTime() / 1000);
		}
			break;
		
		default:
			throw new Error('Invalid period');
	}
	
	return { startTimestamp, endTimestamp };
};

app.get('/api/top-sessions/:period', async (req, res) => {
	try {
		const { period } = req.params;
		const limit = parseInt(req.query.limit) || 50;
		
		if (!['this_week', 'last_week', 'this_month', 'last_month'].includes(period)) {
			return res.status(400).json({ error: 'Invalid period' });
		}
		
		const topSessions = await getTopLongestSessions(period, limit);
		res.json({ period, topSessions });
	} catch (error) {
		console.error(`Error calculating top sessions for ${period}:`, error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/api/top-daily-distances/:period', async (req, res) => {
	try {
		const { period } = req.params;
		const limit = parseInt(req.query.limit) || 50;
		
		if (!['this_week', 'last_week', 'this_month', 'last_month'].includes(period)) {
			return res.status(400).json({ error: 'Invalid period' });
		}
		
		const topDailyDistances = await getTopDailyDistances(period, limit);
		res.json({ period, topDailyDistances });
	} catch (error) {
		console.error(`Error calculating top daily distances for ${period}:`, error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/api/user-category-by-distance/:userId', async (req, res) => {
	try {
		const userId = parseInt(req.params.userId);
		const collection = db.collection('locations');
		
		const userCoordinates = await collection.find({ userId: userId })
				.sort({ sessionId: 1, timestamp: 1 })
				.toArray();
		
		if (userCoordinates.length === 0) {
			return res.status(404).json({ error: 'User not found' });
		}
		
		let northDistance = 0;
		let southDistance = 0;
		let lastPoint = { latitude: userCoordinates[0].latitude, longitude: userCoordinates[0].longitude };
		let lastSessionId = userCoordinates[0].sessionId;
		
		for (let i = 1; i < userCoordinates.length; i++) {
			const coord = userCoordinates[i];
			const currentPoint = { latitude: coord.latitude, longitude: coord.longitude };
			
			// If it's a new session, don't calculate distance from last point of previous session
			if (coord.sessionId !== lastSessionId) {
				lastPoint = currentPoint;
				lastSessionId = coord.sessionId;
				continue;
			}
			
			const distance = haversine(lastPoint, currentPoint) / 1000; // Convert meters to kilometers
			
			if (coord.latitude >= centerLat) {
				northDistance += distance;
			} else {
				southDistance += distance;
			}
			
			lastPoint = currentPoint;
		}
		
		const totalDistance = northDistance + southDistance;
		const category = northDistance > southDistance ? 'north' : 'south';
		
		res.json({
			userId: userId,
			totalDistance: totalDistance.toFixed(2),
			northDistance: northDistance.toFixed(2),
			southDistance: southDistance.toFixed(2),
			category: category,
			percentageInNorth: ((northDistance / totalDistance) * 100).toFixed(2),
			percentageInSouth: ((southDistance / totalDistance) * 100).toFixed(2)
		});
	} catch (error) {
		console.error('Error processing request:', error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

app.get('/api/total-category-by-distance/:period', async (req, res) => {
    try {
        const { period } = req.params;
        const collection = db.collection('locations');
        
        let startTimestamp, endTimestamp;
        
        // Используем логику определения временных рамок из правильной функции
        const now = new Date();
        switch(period) {
            case 'this_week':
            {
                const dayOfWeek = now.getDay();
                const monday = new Date(now);
                monday.setHours(0, 0, 0, 0);
                monday.setDate(now.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                const sunday = new Date(monday);
                sunday.setDate(monday.getDate() + 6);
                sunday.setHours(23, 59, 59, 999);
                
                startTimestamp = Math.floor(monday.getTime() / 1000);
                endTimestamp = Math.floor(sunday.getTime() / 1000);
            }
            break;
            case 'last_week':
            {
                const lastWeek = new Date(now);
                lastWeek.setDate(lastWeek.getDate() - 7);
                
                const dayOfWeek = lastWeek.getDay();
                const lastMonday = new Date(lastWeek);
                lastMonday.setHours(0, 0, 0, 0);
                lastMonday.setDate(lastWeek.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
                const lastSunday = new Date(lastMonday);
                lastSunday.setDate(lastMonday.getDate() + 6);
                lastSunday.setHours(23, 59, 59, 999);
                
                startTimestamp = Math.floor(lastMonday.getTime() / 1000);
                endTimestamp = Math.floor(lastSunday.getTime() / 1000);
            }
            break;
            case 'this_month':
            {
                const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
                const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                lastDayOfMonth.setHours(23, 59, 59, 999);
                
                startTimestamp = Math.floor(firstDayOfMonth.getTime() / 1000);
                endTimestamp = Math.floor(lastDayOfMonth.getTime() / 1000);
            }
            break;
            case 'last_month':
            {
                const firstDayOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                const lastDayOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
                lastDayOfLastMonth.setHours(23, 59, 59, 999);
                
                startTimestamp = Math.floor(firstDayOfLastMonth.getTime() / 1000);
                endTimestamp = Math.floor(lastDayOfLastMonth.getTime() / 1000);
            }
            break;
            default:
                return res.status(400).json({ error: 'Invalid period parameter' });
        }

        const result = await collection.aggregate([
            {
                $match: {
                    timestamp: { $gte: startTimestamp, $lte: endTimestamp }
                }
            },
            {
                $group: {
                    _id: { userId: "$userId", sessionId: "$sessionId" },
                    coordinates: {
                        $push: {
                            latitude: "$latitude",
                            longitude: "$longitude",
                            timestamp: "$timestamp"
                        }
                    }
                }
            }
        ]).toArray();

        if (result.length === 0) {
            return res.status(404).json({ error: 'No data found for the specified period' });
        }
        
        let northDistance = 0;
        let southDistance = 0;
        
        for (const session of result) {
            const coordinates = session.coordinates;
            
            for (let i = 1; i < coordinates.length; i++) {
                const prev = coordinates[i - 1];
                const curr = coordinates[i];
                
                // Проверяем, что точки принадлежат одной сессии (разница во времени менее часа)
                if (curr.timestamp - prev.timestamp < 3600) {
                    const distance = haversine(
                        { lat: prev.latitude, lon: prev.longitude },
                        { lat: curr.latitude, lon: curr.longitude }
                    );
                    
                    if (curr.latitude >= centerLat) {
                        northDistance += distance;
                    } else {
                        southDistance += distance;
                    }
                }
            }
        }
        
        const totalDistance = (northDistance + southDistance) / 1000; // Конвертируем в километры
        northDistance /= 1000;
        southDistance /= 1000;
        
        const category = northDistance > southDistance ? 'north' : 'south';
        
        res.json({
            period: period,
            totalDistance: totalDistance.toFixed(2),
            northDistance: northDistance.toFixed(2),
            southDistance: southDistance.toFixed(2),
            category: category,
            percentageInNorth: ((northDistance / totalDistance) * 100).toFixed(2),
            percentageInSouth: ((southDistance / totalDistance) * 100).toFixed(2)
        });
    } catch (error) {
        console.error('Error processing request:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

connectToMongoDB();
