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

// Raw message logging. On by default — seeing the actual segments is most of why anyone
// tails this — but it does put message content, patient identifiers included, into the
// pod log. One simulator serves every environment, so this switch is cluster-wide.
const LOG_RAW = (process.env.HL7_LOG_RAW ?? 'true').toLowerCase() !== 'false'

// Truncation is per segment, not per message: cutting the message at N characters would
// drop the trailing segments outright, and those are often the interesting ones. A single
// OBX carrying a base64 PDF is what actually floods a terminal; capping each segment keeps
// the whole shape of the message visible and trims only the payload.
const SEGMENT_MAX = Number(process.env.HL7_LOG_SEGMENT_MAX ?? 300)
const SEGMENT_COUNT_MAX = Number(process.env.HL7_LOG_MAX_SEGMENTS ?? 40)

const stamp = () => new Date().toISOString()
const log = (...parts) => console.log(stamp(), ...parts)
const peerOf = (socket) => `${socket?.remoteAddress ?? '?'}:${socket?.remotePort ?? '?'}`

/**
 * The message as it arrived, one segment per line, each capped.
 *
 * Segments are \r-separated on the wire; printing them on their own lines is the whole
 * readability win over dumping the message as a single string.
 */
const renderRaw = (text) => {
  const segments = text.split('\r').filter((s) => s.length > 0)
  const shown = segments.slice(0, SEGMENT_COUNT_MAX)

  const lines = shown.map((seg) => {
    if (seg.length <= SEGMENT_MAX) return `    ${seg}`
    return `    ${seg.slice(0, SEGMENT_MAX)}…[+${seg.length - SEGMENT_MAX} chars]`
  })

  if (segments.length > shown.length) {
    lines.push(`    …[+${segments.length - shown.length} more segments]`)
  }

  const header = `  raw: ${segments.length} segment${segments.length === 1 ? '' : 's'}, ${text.length} chars`
  return [header, ...lines].join('\n')
}

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
    let raw
    try {
      const msg = req.getMessage()
      raw = msg.toString()
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
    if (LOG_RAW && raw) console.log(renderRaw(raw))

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
