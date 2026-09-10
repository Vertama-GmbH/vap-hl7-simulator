/*
 * HL7 v2 MLLP test receiver.
 *
 * Accepts a connection, ACKs whatever arrives, logs what it saw. That is the whole
 * job: it exists so an endpoint can be exercised without sending into a live KIS.
 *
 * Everything here is deliberate rather than default:
 *
 *  - acceptAnyVersion, because a test receiver that rejects a message on MSH-12 is
 *    testing the wrong thing. The library otherwise demands an explicit version list
 *    and refuses to start without one — which is exactly what broke the upstream demo
 *    server we replaced.
 *
 *  - A connection is logged only once it carries data. Kubernetes probes this port with
 *    a TCP socket, connecting and closing a millisecond later without sending anything.
 *    A probe and a client must not look alike in a log someone is tailing precisely to
 *    find out whether the client connected at all.
 *
 *  - Every message is logged with the fields you need mid-debug — control ID, type,
 *    version, sender — and the peer address, which is how you tell dev from prod when
 *    one simulator serves both. Logs are the only output this thing has; nothing is
 *    stored, and there is no API to ask it what it received.
 */

const { Server } = require('node-hl7-server')

const PORT = Number(process.env.HL7_PORT ?? 3000)
const BIND = process.env.HL7_BIND_ADDRESS ?? '0.0.0.0'

const stamp = () => new Date().toISOString()
const log = (...parts) => console.log(stamp(), ...parts)
const peerOf = (socket) => `${socket?.remoteAddress ?? '?'}:${socket?.remotePort ?? '?'}`

const server = new Server({ bindAddress: BIND })

const inbound = server.createInbound(
  { port: PORT, acceptAnyVersion: true },
  async (req, res) => {
    let peer = '?'
    try {
      peer = peerOf(req.getSocket())
    } catch {
      // Socket already gone; the message is still worth reporting.
    }

    let describe
    try {
      const msg = req.getMessage()
      describe = [
        `type=${msg.get('MSH.9').toString()}`,
        `control-id=${msg.get('MSH.10').toString()}`,
        `version=${msg.get('MSH.12').toString()}`,
        `sender=${msg.get('MSH.3').toString()}/${msg.get('MSH.4').toString()}`,
      ].join(' ')
    } catch (err) {
      // A message we cannot read is still worth ACKing and worth logging — silence
      // here would look identical to "nothing arrived".
      describe = `unreadable (${err.message})`
    }

    log(`message from ${peer}`, describe)
    await res.sendResponse('AA')
  },
)

// Attaching our own listeners to the socket rather than logging on `client.connect`:
// only a connection that actually sends a byte gets a line, so health probes stay
// silent. Extra listeners do not consume the stream — the library still sees the data.
inbound.on('client.connect', (socket) => {
  const peer = peerOf(socket)
  let spoke = false
  // Prepended, because the library attached its own `data` listener first: without this
  // its parse completes and logs the message before we log the connection that carried
  // it, and the log reads backwards.
  socket.prependOnceListener('data', () => {
    spoke = true
    log(`client connected ${peer}`)
  })
  socket.once('close', () => {
    if (spoke) log(`client disconnected ${peer}`)
  })
})

inbound.on('listen', () => log(`listening on ${BIND}:${PORT} — ACKs everything, stores nothing`))
inbound.on('client.error', (err) => log('client error:', err?.message ?? err))
inbound.on('data.error', (err) => log('data error:', err?.message ?? err))
inbound.on('error', (err) => log('server error:', err?.message ?? err))

// Kubernetes sends SIGTERM; without this the process is SIGKILLed after the grace
// period and open MLLP connections are cut rather than closed.
const shutdown = async (signal) => {
  log(`${signal} received — closing`)
  try {
    await inbound.close()
  } catch (err) {
    log('error while closing:', err?.message ?? err)
  }
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
