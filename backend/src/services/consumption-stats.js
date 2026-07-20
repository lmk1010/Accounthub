/**
 * ConsumptionStats - MySQL-only wrapper
 * Delegates to the database-backed implementation.
 */

import { consumptionStatsDB, getConsumptionStats, updateConsumptionStats, resetConsumptionStats } from './consumption-stats-db.js';

export { consumptionStatsDB as consumptionStats, getConsumptionStats, updateConsumptionStats, resetConsumptionStats };
