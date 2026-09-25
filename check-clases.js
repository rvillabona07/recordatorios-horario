const admin = require("firebase-admin");

const credencial = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(credencial) });

const ZONA_HORARIA = "America/Bogota";
const MINUTOS_ANTES = 5;
const URL_APP = "https://rvillabona07.github.io/horario-universidad/";

// Para no llenar de avisos a la gente:
const MINUTOS_HUECO = 30; // "salió de clase" solo si los dos tienen al menos este rato libre
const MAX_FOTOS_SALIDA_DIA = 2; // "📸 ¡Saliste de clase!" como mucho estas veces al día

function fechaLocal() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONA_HORARIA }).format(new Date());
}

// Preferencias que cada persona elige en la app (🔔). Por defecto, todo activo.
function quiere(preferencias, tipo) {
  return (preferencias || {})[tipo] !== false;
}

// ¿Le queda un hueco de verdad? (ninguna clase más hoy, o la siguiente
// empieza al menos MINUTOS_HUECO después de la que acaba de terminar).
function tieneHueco(clases, dia, minutoSalida) {
  const proximas = clases
    .filter((c) => c.dias && c.dias.includes(dia) && minutosDesdeMedianoche(c.horaInicio) >= minutoSalida)
    .map((c) => minutosDesdeMedianoche(c.horaInicio));
  return proximas.length === 0 || Math.min(...proximas) - minutoSalida >= MINUTOS_HUECO;
}

function mensajeVariosLibres(nombres) {
  const lista =
    nombres.length === 2
      ? `${nombres[0]} y ${nombres[1]}`
      : `${nombres[0]}, ${nombres[1]} y ${nombres.length - 2} más`;
  return {
    title: `🎉 ${lista} salieron de clase`,
    body: "Tienen un rato libre. ¿Se juntan a hacer algo?",
  };
}

const MAPA_DIAS = {
  Sunday: "Domingo",
  Monday: "Lunes",
  Tuesday: "Martes",
  Wednesday: "Miércoles",
  Thursday: "Jueves",
  Friday: "Viernes",
  Saturday: "Sábado",
};

function obtenerDiaYHoraLocal() {
  const formateador = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONA_HORARIA,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const partes = formateador.formatToParts(new Date());
  const obtener = (tipo) => partes.find((p) => p.type === tipo).value;

  let hora = obtener("hour");
  if (hora === "24") hora = "00";

  return { dia: MAPA_DIAS[obtener("weekday")], horaMinuto: `${hora}:${obtener("minute")}` };
}

function minutosDesdeMedianoche(horaStr) {
  const [h, m] = horaStr.split(":").map(Number);
  return h * 60 + m;
}

// La de la cerveza va aparte para poder darle más peso los jueves y viernes.
const MENSAJE_CERVEZA = (nombre) => ({
  title: `🍺 ${nombre} salió de clase`,
  body: "Hace calor para una cervecita... solo digo. Escríbele. 😏",
});
const DIAS_DE_CERVEZA = ["Jueves", "Viernes"];
const PROBABILIDAD_CERVEZA = 0.5; // esos días sale la mitad de las veces

const MENSAJES_LIBRE = [
  (nombre) => ({
    title: `🍔 ${nombre} ya salió de clase`,
    body: "Escríbele y caigan a comer algo, que con hambre nadie piensa.",
  }),
  (nombre) => ({
    title: `☕ ${nombre} quedó libre`,
    body: "¿Un tintico o un café? Mándale un mensaje y se toman algo.",
  }),
  (nombre) => ({
    title: `📚 ${nombre} acaba de salir`,
    body: "Buen momento para estudiar juntos o adelantar ese taller.",
  }),
  (nombre) => ({
    title: `🚶 ${nombre} está libre`,
    body: "Invítalo a dar una vuelta por el campus y despejar la cabeza.",
  }),
  MENSAJE_CERVEZA,
  (nombre) => ({
    title: `💬 ${nombre} ya se desocupó`,
    body: "Salúdalo, de pronto está buscando con quién charlar un rato.",
  }),
  (nombre) => ({
    title: `🎱 ${nombre} quedó libre`,
    body: "¿Unas bolas de pool o un chico de billar? Escríbele y le cae.",
  }),
  (nombre) => ({
    title: `🥐 ${nombre} acaba de terminar clase`,
    body: "Momento perfecto para unas empanadas en la cafetería. ¿Le escribes?",
  }),
  (nombre) => ({
    title: `😎 ${nombre} está libre ahora`,
    body: "Cuádrale un plan antes de que agarre otra vuelta.",
  }),
  (nombre) => ({
    title: `🎉 ${nombre} ya salió`,
    body: "¿Armamos parche? Escríbele y miren qué hacen juntos.",
  }),
];

// Jueves y viernes: la cerveza sale la mitad de las veces. Los demás días,
// o si no le tocó, se elige cualquiera de las otras frases al azar.
function elegirMensajeLibre(nombre, dia) {
  if (DIAS_DE_CERVEZA.includes(dia) && Math.random() < PROBABILIDAD_CERVEZA) {
    return MENSAJE_CERVEZA(nombre);
  }
  const opciones = DIAS_DE_CERVEZA.includes(dia)
    ? MENSAJES_LIBRE.filter((m) => m !== MENSAJE_CERVEZA)
    : MENSAJES_LIBRE;
  return opciones[Math.floor(Math.random() * opciones.length)](nombre);
}

const formatoPesos = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

// Lo que "deudor" le debe a "acreedor" en total, cruzando las cuentas
// pendientes entre los dos (negativo = el acreedor es quien debe).
// pagos[uid] solo cuenta como pagado cuando es true (confirmado); false y
// "reportado" (quien debe dice que pagó, falta confirmar) siguen pendientes.
function saldoEntre(cuentas, deudor, acreedor) {
  let saldo = 0;
  cuentas.forEach((cuenta) => {
    const participantes = cuenta.participantes || [];
    if (cuenta.creador === acreedor && participantes.includes(deudor) && cuenta.pagos?.[deudor] !== true) {
      saldo += cuenta.porPersona;
    }
    if (cuenta.creador === deudor && participantes.includes(acreedor) && cuenta.pagos?.[acreedor] !== true) {
      saldo -= cuenta.porPersona;
    }
  });
  return saldo;
}

function mensajeCuenta(cuenta, nombre, neto) {
  const parte = formatoPesos.format(cuenta.porPersona);
  if (neto === cuenta.porPersona) {
    return {
      title: `💸 Le debes ${parte} a ${nombre}`,
      body: `Por "${cuenta.descripcion}". Total ${formatoPesos.format(cuenta.total)} dividido entre ${cuenta.personas}.`,
    };
  }
  if (neto > 0) {
    return {
      title: `💸 Le debes ${formatoPesos.format(neto)} a ${nombre}`,
      body: `Nueva cuenta "${cuenta.descripcion}" (tu parte: ${parte}). Cruzando lo que se deben entre ustedes, en total le debes ${formatoPesos.format(neto)}.`,
    };
  }
  return {
    title: `💸 ${nombre} dividió "${cuenta.descripcion}"`,
    body: `Tu parte es ${parte}, pero cruzando lo que se deben, ${
      neto < 0 ? `${nombre} te debe ${formatoPesos.format(-neto)} a ti` : "quedan a mano"
    }.`,
  };
}

// Cuentas divididas desde la pestaña "Cuentas" de la app: avisa a cada
// participante cuánto debe y a quién, una sola vez por cuenta. Solo a los
// amigos aceptados de quien la creó (un desconocido no puede cobrarte).
// Primero busca solo las cuentas sin avisar (casi siempre ninguna) y solo
// entonces lee las demás, para gastar poco del cupo gratis de Firebase.
async function avisarCuentasNuevas(db, tokenPorUid, preferenciasPorUid, amigosDe, envios, escrituras) {
  const nuevas = await db.collection("cuentas").where("notificado", "==", false).get();
  if (nuevas.empty) return;
  const todas = (await db.collection("cuentas").get()).docs.map((d) => d.data());
  const amigosPorUid = await amigosDe();

  for (const documento of nuevas.docs) {
    const cuenta = documento.data();

    let nombre = "Un amigo";
    try {
      const perfil = await db.collection("perfiles").doc(cuenta.creador).get();
      if (perfil.exists && perfil.data().apodo) nombre = perfil.data().apodo;
    } catch (error) {
      console.error("Error obteniendo perfil:", error.message);
    }

    const amigosDelCreador = amigosPorUid[cuenta.creador] || [];
    (cuenta.participantes || []).forEach((uid) => {
      const token = tokenPorUid[uid];
      if (!token || !quiere(preferenciasPorUid[uid], "cuentas")) return;
      if (!amigosDelCreador.includes(uid)) return;
      const mensaje = mensajeCuenta(cuenta, nombre, saldoEntre(todas, uid, cuenta.creador));
      envios.push(
        admin
          .messaging()
          .send({ token, data: mensaje })
          .catch((error) => console.error("Error avisando cuenta:", error.message))
      );
    });

    escrituras.push(
      documento.ref
        .update({ notificado: true })
        .catch((error) => console.error("Error marcando cuenta:", error.message))
    );
  }
}

// Una sola vez: reserva en apodos/ los apodos que ya existían de antes de
// que fueran únicos (con la misma clave que usa la app: minúsculas y sin
// espacios de más). Si dos personas tenían el mismo, lo reserva el primero;
// el otro lo conserva hasta que lo cambie. Después solo lee config/apodos.
async function reservarApodosViejos(db) {
  const marca = db.collection("config").doc("apodos");
  if ((await marca.get()).data()?.reservados) return;

  const perfiles = await db.collection("perfiles").get();
  let reservados = 0;
  let repetidos = 0;
  for (const perfil of perfiles.docs) {
    const { apodo, apodoClave } = perfil.data();
    if (typeof apodo !== "string" || apodoClave) continue;
    const clave = apodo.trim().toLowerCase().replace(/ +/g, " ");
    if (!clave || clave.includes("/") || /^\.*$/.test(clave) || /^__.*__$/.test(clave)) continue;
    const referencia = db.collection("apodos").doc(clave);
    const quedoReservado = await db.runTransaction(async (transaccion) => {
      if ((await transaccion.get(referencia)).exists) return false;
      transaccion.set(referencia, { uid: perfil.id });
      transaccion.update(perfil.ref, { apodoClave: clave });
      return true;
    });
    if (quedoReservado) reservados++;
    else repetidos++;
  }
  await marca.set({ reservados: true, fecha: Date.now() });
  console.log(`Apodos viejos reservados: ${reservados} (repetidos: ${repetidos}).`);
}

// ---------- Cupo gratis de Firebase ----------
// El plan gratis da 50.000 lecturas y 20.000 escrituras al día, y esto
// corre cada 5 minutos (288 veces al día). Para no pasarse:
// - De 12:05 a. m. a 4:55 a. m. no hay clases: no se lee nada.
// - "En clase"/"Libre" se calcula con el horario (ahora y hace 5 minutos)
//   en vez de leer todos los estados, y solo se guarda cuando cambia.
// - Amistades, cuentas y avisos ya enviados se leen solo si hacen falta.
const NOCHE_DESDE = 5; // 00:05
const NOCHE_HASTA = 4 * 60 + 55; // 04:55
const MINUTOS_ENTRE_REVISIONES = 5;
// Si alguien cambió su horario hace poco, se le guarda el estado aunque no
// haya cambiado (la app marca "cambiado" al guardar las clases).
const MINUTOS_HORARIO_RECIENTE = 10;

function enClaseEn(clases, dia, minuto) {
  return clases.some(
    (clase) =>
      clase.dias &&
      clase.dias.includes(dia) &&
      minutosDesdeMedianoche(clase.horaInicio) <= minuto &&
      minuto < minutosDesdeMedianoche(clase.horaFin)
  );
}

async function main() {
  const { dia, horaMinuto } = obtenerDiaYHoraLocal();
  const minutoActual = minutosDesdeMedianoche(horaMinuto);
  console.log(`Revisión: dia=${dia} horaMinuto=${horaMinuto}`);
  if (minutoActual >= NOCHE_DESDE && minutoActual < NOCHE_HASTA) {
    console.log("De noche: nada que revisar.");
    return;
  }

  const db = admin.firestore();

  // Un error aquí no debe frenar los avisos de clases.
  try {
    await reservarApodosViejos(db);
  } catch (error) {
    console.error("Error reservando apodos:", error.message);
  }

  const snapshotHorarios = await db.collection("horarios").get();

  // Amistades aceptadas: se leen una sola vez y solo si hacen falta.
  let amigosPorUid = null;
  const amigosDe = async () => {
    if (!amigosPorUid) {
      amigosPorUid = {};
      const solicitudes = await db.collection("solicitudesAmistad").where("estado", "==", "aceptada").get();
      solicitudes.forEach((d) => {
        const { de, para } = d.data();
        (amigosPorUid[de] ||= []).push(para);
        (amigosPorUid[para] ||= []).push(de);
      });
    }
    return amigosPorUid;
  };

  const ahora = Date.now();
  const minutoAnterior = minutoActual - MINUTOS_ENTRE_REVISIONES;
  // En la primera revisión de la mañana se guardan todos los estados, por
  // si alguno quedó mal (por ejemplo, una clase que se borró de noche).
  const refrescarTodos = minutoActual >= NOCHE_HASTA && minutoActual < NOCHE_HASTA + MINUTOS_ENTRE_REVISIONES;

  const envios = [];
  const escrituras = [];
  const tokenPorUid = {};
  const nuevoEstadoPorUid = {};
  const clasesPorUid = {};
  const preferenciasPorUid = {};
  const acabanDeSalir = [];

  snapshotHorarios.forEach((documento) => {
    const uid = documento.id;
    const datos = documento.data();
    const token = datos.fcmToken;
    const clases = datos.clases || [];

    tokenPorUid[uid] = token || null;
    clasesPorUid[uid] = clases;
    preferenciasPorUid[uid] = datos.preferencias || {};

    if (token && quiere(preferenciasPorUid[uid], "clases")) {
      clases.forEach((clase) => {
        if (!clase.dias || !clase.dias.includes(dia)) return;

        const faltan = minutosDesdeMedianoche(clase.horaInicio) - minutoActual;
        if (faltan <= 0 || faltan > MINUTOS_ANTES) return;

        envios.push(
          admin
            .messaging()
            .send({
              token,
              data: {
                title: `${clase.materia} en ${MINUTOS_ANTES} minutos`,
                body: `Empieza a las ${clase.horaInicio}${clase.aula ? " · " + clase.aula : ""}`,
              },
            })
            .catch((error) => console.error("Error enviando notificación:", error.message))
        );
      });
    }

    const enClaseAhora = enClaseEn(clases, dia, minutoActual);
    const estabaEnClase = enClaseEn(clases, dia, minutoAnterior);
    nuevoEstadoPorUid[uid] = enClaseAhora ? "En clase" : "Libre";
    if (estabaEnClase && !enClaseAhora) acabanDeSalir.push(uid);

    const horarioReciente = (datos.cambiado || 0) > ahora - MINUTOS_HORARIO_RECIENTE * 60 * 1000;
    if (enClaseAhora !== estabaEnClase || horarioReciente || refrescarTodos) {
      escrituras.push(
        db
          .collection("estados")
          .doc(uid)
          .set({ estado: nuevoEstadoPorUid[uid], actualizado: ahora })
          .catch((error) => console.error("Error actualizando estado:", error.message))
      );
    }
  });

  const enviar = (token, data, descripcion) =>
    envios.push(
      admin
        .messaging()
        .send({ token, data })
        .catch((error) => console.error(`Error enviando ${descripcion}:`, error.message))
    );

  const hoy = fechaLocal();
  // Quién salió y a quién hay que avisarle: receptor -> [nombres de amigos].
  const libresPorReceptor = {};

  for (const uid of acabanDeSalir) {
    const amigos = (await amigosDe())[uid] || [];
    if (amigos.length === 0) continue;

    // Si tiene otra clase enseguida no es un hueco: no se avisa nada.
    const clases = clasesPorUid[uid] || [];
    const terminada = clases
      .filter((c) => c.dias && c.dias.includes(dia) && minutosDesdeMedianoche(c.horaFin) <= minutoActual)
      .sort((a, b) => minutosDesdeMedianoche(b.horaFin) - minutosDesdeMedianoche(a.horaFin))[0];
    const minutoSalida = terminada ? minutosDesdeMedianoche(terminada.horaFin) : minutoActual;
    if (!tieneHueco(clases, dia, minutoSalida)) continue;

    // A quien acaba de salir: invitación a compartir una foto (máx. 2 al día).
    // avisosEnviados/{uid} guarda cuántas lleva hoy.
    if (tokenPorUid[uid] && quiere(preferenciasPorUid[uid], "fotos")) {
      let registroFotos = {};
      try {
        registroFotos = (await db.collection("avisosEnviados").doc(uid).get()).data()?.fotosSalida || {};
      } catch (error) {
        console.error("Error leyendo avisos enviados:", error.message);
      }
      const fotosHoy = registroFotos.fecha === hoy ? registroFotos.cuenta : 0;
      if (fotosHoy < MAX_FOTOS_SALIDA_DIA) {
        enviar(
          tokenPorUid[uid],
          {
            title: `📸 ¡Saliste de ${terminada ? terminada.materia : "clase"}!`,
            body: "Toma una foto de dónde estás: tus amigos la verán por 10 minutos.",
            url: `${URL_APP}?foto=1`,
          },
          "invitación a foto"
        );
        escrituras.push(
          db
            .collection("avisosEnviados")
            .doc(uid)
            .set({ fotosSalida: { fecha: hoy, cuenta: fotosHoy + 1 } }, { merge: true })
            .catch((error) => console.error("Error guardando registro de avisos:", error.message))
        );
      }
    }

    let nombre = "Tu amigo";
    try {
      const perfil = await db.collection("perfiles").doc(uid).get();
      if (perfil.exists && perfil.data().apodo) nombre = perfil.data().apodo;
    } catch (error) {
      console.error("Error obteniendo perfil:", error.message);
    }

    amigos.forEach((amigoUid) => {
      if (!tokenPorUid[amigoUid]) return;
      if (!quiere(preferenciasPorUid[amigoUid], "amigos")) return;
      // Solo si los dos tienen hueco: el amigo no está en clase y tampoco
      // tiene una clase por empezar en los próximos MINUTOS_HUECO.
      if (nuevoEstadoPorUid[amigoUid] === "En clase") return;
      if (!tieneHueco(clasesPorUid[amigoUid] || [], dia, minutoActual)) return;

      (libresPorReceptor[amigoUid] ||= []).push(nombre);
    });
  }

  // Un solo aviso por persona, aunque hayan salido varios amigos a la vez.
  Object.entries(libresPorReceptor).forEach(([receptor, nombres]) => {
    const mensaje =
      nombres.length === 1
        ? elegirMensajeLibre(nombres[0], dia)
        : mensajeVariosLibres(nombres);
    enviar(tokenPorUid[receptor], mensaje, "aviso a amigo");
  });

  // Un error con las cuentas no debe frenar los avisos de clases.
  try {
    await avisarCuentasNuevas(db, tokenPorUid, preferenciasPorUid, amigosDe, envios, escrituras);
  } catch (error) {
    console.error("Error revisando cuentas:", error.message);
  }

  // Borra las fotos instantáneas que ya pasaron sus 10 minutos.
  try {
    const vencidas = await db.collection("fotos").where("expira", "<", Date.now()).get();
    vencidas.forEach((foto) => escrituras.push(foto.ref.delete()));
    if (!vencidas.empty) console.log(`Borrando ${vencidas.size} foto(s) vencida(s).`);
  } catch (error) {
    console.error("Error borrando fotos:", error.message);
  }

  // Borra las burbujas de chat (likes/comentarios) con más de 30 minutos
  // sin movimiento; la app ya no las muestra.
  try {
    const viejos = await db.collection("chats").where("actualizada", "<", Date.now() - 30 * 60 * 1000).get();
    viejos.forEach((chat) => escrituras.push(chat.ref.delete()));
    if (!viejos.empty) console.log(`Borrando ${viejos.size} chat(s) vencido(s).`);
  } catch (error) {
    console.error("Error borrando chats:", error.message);
  }

  await Promise.all([...envios, ...escrituras]);
  console.log(
    `Revisado ${dia} ${horaMinuto}: ${snapshotHorarios.size} horario(s), ${envios.length} aviso(s), ${escrituras.length} escritura(s).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
