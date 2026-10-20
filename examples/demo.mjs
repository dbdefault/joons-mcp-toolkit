import { RequestCoordinator } from '../src/request-coordinator.mjs';
const coordinator = new RequestCoordinator();
const task = async ({ text }) => ({ accepted: true, echo: text });
console.log(await coordinator.run('example-001', { text: 'hello' }, task));
console.log(coordinator.get('example-001'));
