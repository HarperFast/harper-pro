/**
 * HarperFast/harper#1212's drop-table scenarios with `replication.threads` on: replication sockets live on pool
 * workers while the operations API opens databases on the HTTP workers, so a drop marker can arrive on a thread
 * other than the one that opened its database. Runs the offline drop, rejoin and recreate (2, 2b, 2c), the
 * node-local table (5) and the joining node (6); the rest exercise nothing thread-dependent beyond these.
 */
import { dropTableOfflinePeerSuite } from './dropTableOfflinePeerSuite.mjs';

dropTableOfflinePeerSuite({ replicationThreads: 2, scenarios: ['2', '2c', '5', '6'] });
