import { tables } from 'harper';

tables.ComputedRow.setComputedAttribute('upper', (record) => record.name?.toUpperCase());
