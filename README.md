# Geolocation & Stats Backend

Бэкенд на **Node.js + Express + MongoDB** для работы с геолокацией пользователей, зарядными станциями, маршрутами, тепловыми картами и статистикой перемещений.

Подходит для картографических приложений (например, Monopiter).

---

## Возможности

* Отслеживание геопозиций пользователей
* Активные пользователи + расчёт средней скорости
* Маршруты за период
* Тепловые карты:

  * по диапазону дат
  * месячные (предрасчитанные)
  * годовые (агрегация по месяцам)
* Работа с зарядными станциями:

  * создание / редактирование / удаление
  * загрузка фото (multer + sharp)
  * лайки и дизлайки
* Категории по дистанциям ("north/south")
* Топы по дистанциям (неделя, месяц)
* Проксирование аватарок с шифрованием URL
* Получение списка мастерских из другой БД

---

## Стек

| Технология         | Использование                        |
| ------------------ | ------------------------------------ |
| Node.js / Express  | HTTP API                             |
| MongoDB            | Хранение геоданных                   |
| haversine-distance | Вычисление расстояния по координатам |
| multer             | Загрузка изображений                 |
| sharp              | Обработка фото                       |
| node-fetch         | Проксирование URL                    |
| AES-256-CBC        | Шифрование URL аватарок              |
| dotenv             | Конфигурация                         |

---

## Установка

### 1. Клонирование

```bash
git clone <repo-url>
cd <project-folder>
npm install
```

### 2. Переменные окружения

Создать файл `.env`:

```env
API_BASE_URL=https://api.monopiter.ru
ENCRYPTION_KEY=<64 hex chars>    # AES-256 key, например 32 байта в hex
```

> **ENCRYPTION_KEY обязателен** — используется для шифрования URL аватаров.

### 3. Запуск

```bash
node server.js
```

По умолчанию:

```
http://localhost:5001
```

---

## Статические файлы

Папка: `./uploads`

Доступ:

```
GET /uploads/<filename>
```

Используется для фото зарядных станций.

---

## Основные коллекции MongoDB

### `locations` (geolocation_db.locations)

Хранит точки трекинга:

```json
{
  "userId": 123,
  "username": "John",
  "sessionId": 12,
  "latitude": 59.9,
  "longitude": 30.3,
  "timestamp": 1710000000,
  "avatarUrl": "https://..."
}
```

Используется для:

* активных пользователей
* маршрутов
* топов
* тепловых карт
* подсчёта north/south

---

### `charging_stations`

```json
{
  "latitude": 59.9,
  "longitude": 30.3,
  "comment": "Free charger",
  "photo": "https://.../uploads/img.jpg",
  "userId": 12,
  "addedBy": {},
  "addedAt": "2024-01-01",
  "is24Hours": true,
  "markerType": "blue",
  "likes": 0,
  "dislikes": 0,
  "likedBy": [],
  "dislikedBy": []
}
```

---

### `monthly_heatmaps`

Агрегированные точки:

```json
{
  "year": 2024,
  "month": 1,
  "heatmapData": [
    { "latitude": 59.9, "longitude": 30.3, "intensity": 42 }
  ]
}
```

---

### `workshops` (feedback_bot.workshops)

Список мастерских (структура свободная).

---

## 📘 API Documentation – OpenAPI (Swagger)

Полная спецификация доступна в файле:

```
openapi.yaml
```

Можно открыть через:

* [https://editor.swagger.io](https://editor.swagger.io)
* любой Swagger UI

Спецификация включает все эндпоинты:

* /api/active-users
* /api/charging-stations
* /api/heatmap
* /api/route/{userId}
* /api/top-users/*
* /api/total-distance/*
* /api/user-category-by-distance/*
* /api/top-sessions/*
* /api/top-daily-distances/*
* /secure-avatar/*
* /api/workshops

---

## 🧠 Логика расчётов

### Расстояния

Используется:

```
haversine(prev, curr)
```

Возвращает метры → обычно переводится в километры.

### Сессии

* раздельные по `sessionId`
* точки между сессиями не соединяются
* фильтр по времени между точками: `< 3600` секунд

### Неделя

Неделя = **Пн–Вс**
`this_week` и `last_week` вычисляются автоматически.

### North / South

Граница:

```
centerLat = 59.9505
```

Если `latitude >= centerLat` → north, иначе south.

---

## 🛠 Разработка и работа сервера

* Логи подключения MongoDB выводятся в консоль.
* При ошибке подключения — сервер завершает работу.
* Обновление тепловой карты:

  * текущий + предыдущий месяц
  * пересчитывается раз в 24 часа